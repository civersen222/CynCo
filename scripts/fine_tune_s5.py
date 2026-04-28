#!/usr/bin/env python3
"""Fine-tune a small model on S5 decision data using Unsloth.

Reads a JSONL training file (produced by aggregate_training_data.py),
formats examples as chat turns, and fine-tunes a small quantised base
model using LoRA via the Unsloth library.

Prerequisites:
    pip install unsloth transformers trl datasets torch

Usage:
    python fine_tune_s5.py [--training-data path/to/s5_training_data.jsonl]
                           [--model unsloth/Qwen2.5-3B-Instruct-bnb-4bit]
                           [--output-dir ./s5_lora]
                           [--epochs 3]
                           [--batch-size 4]
"""
import argparse
import json
import sys
from pathlib import Path


# ─── Default configuration ──────────────────────────────────────────────────

DEFAULT_TRAINING_DATA = Path.home() / ".localcode" / "training" / "s5_training_data.jsonl"
DEFAULT_MODEL = "unsloth/Qwen2.5-3B-Instruct-bnb-4bit"
DEFAULT_OUTPUT_DIR = Path("./s5_lora")
DEFAULT_EPOCHS = 3
DEFAULT_BATCH_SIZE = 4
MAX_SEQ_LENGTH = 2048


# ─── Data loading ───────────────────────────────────────────────────────────

def load_training_data(path: Path) -> list[dict]:
    """Load JSONL training examples; each line has 'input' and 'output' fields."""
    if not path.exists():
        print(f"[error] Training data not found: {path}", file=sys.stderr)
        print(
            "[hint] Run aggregate_training_data.py first to generate training data.",
            file=sys.stderr,
        )
        sys.exit(1)

    examples = []
    with open(path, encoding="utf-8") as f:
        for line_no, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                ex = json.loads(line)
                if "input" not in ex or "output" not in ex:
                    print(f"[warn] Line {line_no}: missing input/output — skipping", file=sys.stderr)
                    continue
                examples.append(ex)
            except json.JSONDecodeError as e:
                print(f"[warn] Line {line_no}: JSON error — {e}", file=sys.stderr)

    print(f"[fine_tune] Loaded {len(examples)} training examples", file=sys.stderr)
    return examples


def format_as_chat(examples: list[dict]) -> list[dict]:
    """Convert training examples into chat-format messages for SFT."""
    system_prompt = (
        "You are S5, the intelligent decision-making layer of LocalCode. "
        "Given the current system state, output a JSON decision that governs "
        "model selection, tool access, context management, and priority balance."
    )
    chat_examples = []
    for ex in examples:
        chat_examples.append({
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": ex["input"]},
                {"role": "assistant", "content": ex["output"]},
            ]
        })
    return chat_examples


# ─── Fine-tuning ─────────────────────────────────────────────────────────────

def fine_tune(
    training_data: Path,
    model_name: str,
    output_dir: Path,
    epochs: int,
    batch_size: int,
) -> None:
    try:
        from unsloth import FastLanguageModel
        from trl import SFTTrainer
        from transformers import TrainingArguments
        from datasets import Dataset
    except ImportError as e:
        print(f"[error] Missing dependency: {e}", file=sys.stderr)
        print("[hint] Install with: pip install unsloth transformers trl datasets torch", file=sys.stderr)
        sys.exit(1)

    # ── Load model ────────────────────────────────────────────────────────────
    print(f"[fine_tune] Loading model: {model_name}", file=sys.stderr)
    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=model_name,
        max_seq_length=MAX_SEQ_LENGTH,
        load_in_4bit=True,
    )

    # ── Add LoRA adapters ─────────────────────────────────────────────────────
    model = FastLanguageModel.get_peft_model(
        model,
        r=16,
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
        lora_alpha=16,
        lora_dropout=0.0,
        bias="none",
        use_gradient_checkpointing="unsloth",
        random_state=42,
    )

    # ── Prepare dataset ───────────────────────────────────────────────────────
    examples = load_training_data(training_data)
    chat_examples = format_as_chat(examples)
    dataset = Dataset.from_list(chat_examples)

    def apply_chat_template(batch):
        texts = [
            tokenizer.apply_chat_template(msgs, tokenize=False, add_generation_prompt=False)
            for msgs in batch["messages"]
        ]
        return {"text": texts}

    dataset = dataset.map(apply_chat_template, batched=True, remove_columns=["messages"])

    # ── Train ─────────────────────────────────────────────────────────────────
    output_dir.mkdir(parents=True, exist_ok=True)
    trainer = SFTTrainer(
        model=model,
        tokenizer=tokenizer,
        train_dataset=dataset,
        dataset_text_field="text",
        max_seq_length=MAX_SEQ_LENGTH,
        args=TrainingArguments(
            per_device_train_batch_size=batch_size,
            gradient_accumulation_steps=4,
            warmup_steps=5,
            num_train_epochs=epochs,
            learning_rate=2e-4,
            fp16=True,
            logging_steps=10,
            output_dir=str(output_dir / "checkpoints"),
            save_strategy="epoch",
            report_to="none",
        ),
    )

    print(f"[fine_tune] Training for {epochs} epochs on {len(examples)} examples...", file=sys.stderr)
    trainer.train()

    # ── Save LoRA weights ─────────────────────────────────────────────────────
    lora_path = output_dir / "lora_weights"
    model.save_pretrained(str(lora_path))
    tokenizer.save_pretrained(str(lora_path))
    print(f"[fine_tune] LoRA weights saved to: {lora_path}")
    print("[fine_tune] Done. Load with: FastLanguageModel.from_pretrained(lora_path)")


# ─── Entry point ─────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Fine-tune a small model on S5 decision data using Unsloth LoRA"
    )
    parser.add_argument(
        "--training-data",
        type=Path,
        default=DEFAULT_TRAINING_DATA,
        help="Path to JSONL training data (from aggregate_training_data.py)",
    )
    parser.add_argument(
        "--model",
        default=DEFAULT_MODEL,
        help="Unsloth/HF model name (must be 4-bit quantised for low VRAM)",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=DEFAULT_OUTPUT_DIR,
        help="Directory to save LoRA weights and checkpoints",
    )
    parser.add_argument(
        "--epochs",
        type=int,
        default=DEFAULT_EPOCHS,
        help="Number of training epochs",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=DEFAULT_BATCH_SIZE,
        help="Per-device training batch size",
    )
    args = parser.parse_args()

    fine_tune(
        training_data=args.training_data,
        model_name=args.model,
        output_dir=args.output_dir,
        epochs=args.epochs,
        batch_size=args.batch_size,
    )


if __name__ == "__main__":
    main()
