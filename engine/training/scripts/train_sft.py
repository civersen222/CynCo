"""
Unsloth SFT training script for CynCo personalized adapter.

Trains a QLoRA adapter on successful coding trajectories from CynCo's
trajectory store. Uses rejection sampling: only trajectories with
reward >= threshold become training examples.

Usage:
    python train_sft.py --data ~/.cynco/datasets/sft.jsonl \
                        --output ~/.cynco/adapters/sft-v1 \
                        --base unsloth/Qwen2.5-Coder-14B-Instruct

Hardware: RTX 5090 (32GB) — 14B QLoRA fits in ~8.5GB, 27B in ~17GB.
"""

import argparse
import json
import os
import sys

def main():
    parser = argparse.ArgumentParser(description="CynCo SFT training via Unsloth")
    parser.add_argument("--data", required=True, help="Path to SFT JSONL dataset")
    parser.add_argument("--output", required=True, help="Output directory for adapter")
    parser.add_argument("--base", default="unsloth/Qwen2.5-Coder-14B-Instruct",
                        help="Base model (HuggingFace ID or local path)")
    parser.add_argument("--epochs", type=int, default=2, help="Training epochs")
    parser.add_argument("--batch-size", type=int, default=4, help="Per-device batch size")
    parser.add_argument("--grad-accum", type=int, default=8, help="Gradient accumulation steps")
    parser.add_argument("--lr", type=float, default=2e-4, help="Learning rate")
    parser.add_argument("--max-seq-len", type=int, default=4096, help="Max sequence length")
    parser.add_argument("--lora-r", type=int, default=64, help="LoRA rank")
    parser.add_argument("--lora-alpha", type=int, default=64, help="LoRA alpha")
    parser.add_argument("--dry-run", action="store_true", help="Just validate data, don't train")
    args = parser.parse_args()

    # Validate data file
    if not os.path.exists(args.data):
        print(f"ERROR: Data file not found: {args.data}")
        sys.exit(1)

    with open(args.data) as f:
        examples = [json.loads(line) for line in f if line.strip()]

    print(f"Loaded {len(examples)} training examples from {args.data}")

    if len(examples) < 10:
        print(f"WARNING: Only {len(examples)} examples — recommend 300+ for meaningful SFT")

    if args.dry_run:
        print("Dry run — validating data format...")
        for i, ex in enumerate(examples[:5]):
            msgs = ex.get("messages", [])
            print(f"  Example {i}: {len(msgs)} messages, roles: {[m['role'] for m in msgs]}")
        print(f"Data validation OK. {len(examples)} examples ready for training.")
        return

    # ── Unsloth Training ──
    try:
        from unsloth import FastLanguageModel
    except ImportError:
        print("ERROR: Unsloth not installed. Install with:")
        print("  pip install unsloth")
        print("  # Or for RTX 50-series: pip install unsloth[blackwell]")
        sys.exit(1)

    from datasets import Dataset
    from trl import SFTTrainer, SFTConfig

    print(f"Loading base model: {args.base}")
    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=args.base,
        max_seq_length=args.max_seq_len,
        dtype=None,  # auto-detect
        load_in_4bit=True,
    )

    # Apply LoRA
    model = FastLanguageModel.get_peft_model(
        model,
        r=args.lora_r,
        target_modules=[
            "q_proj", "k_proj", "v_proj", "o_proj",
            "gate_proj", "up_proj", "down_proj",
        ],
        lora_alpha=args.lora_alpha,
        lora_dropout=0,
        bias="none",
        use_gradient_checkpointing="unsloth",
    )

    # Build dataset
    def format_example(example):
        return tokenizer.apply_chat_template(
            example["messages"],
            tokenize=False,
            add_generation_prompt=False,
        )

    dataset = Dataset.from_list(examples)
    dataset = dataset.map(lambda x: {"text": format_example(x)}, remove_columns=dataset.column_names)

    print(f"Dataset: {len(dataset)} examples")
    print(f"Sample (first 200 chars): {dataset[0]['text'][:200]}")

    # Training config
    training_args = SFTConfig(
        output_dir=args.output,
        per_device_train_batch_size=args.batch_size,
        gradient_accumulation_steps=args.grad_accum,
        num_train_epochs=args.epochs,
        learning_rate=args.lr,
        warmup_ratio=0.1,
        bf16=True,
        optim="adamw_8bit",
        weight_decay=0.01,
        logging_steps=10,
        save_strategy="epoch",
        dataset_text_field="text",
        max_seq_length=args.max_seq_len,
        packing=True,
    )

    trainer = SFTTrainer(
        model=model,
        tokenizer=tokenizer,
        train_dataset=dataset,
        args=training_args,
    )

    print("Starting training...")
    trainer.train()

    # Save adapter
    os.makedirs(args.output, exist_ok=True)
    model.save_pretrained(args.output)
    tokenizer.save_pretrained(args.output)
    print(f"Adapter saved to {args.output}")

    # Save training metadata
    meta = {
        "base_model": args.base,
        "examples": len(examples),
        "epochs": args.epochs,
        "lora_r": args.lora_r,
        "lora_alpha": args.lora_alpha,
        "lr": args.lr,
        "max_seq_len": args.max_seq_len,
    }
    with open(os.path.join(args.output, "training_meta.json"), "w") as f:
        json.dump(meta, f, indent=2)

    print("Training complete!")


if __name__ == "__main__":
    main()
