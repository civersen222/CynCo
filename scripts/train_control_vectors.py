"""
Train control vectors for governance-driven activation steering.

Level 2: Extract behavioral directions from the model's hidden states
using contrasting conversation pairs. The governance system then
injects these vectors at inference time based on system state.

This feeds into Level 4: vectors are versioned, A/B tested, and
retrained as the governance system collects more outcome data.

Usage:
  python scripts/train_control_vectors.py --model Qwen/Qwen3.6-35B-A3B --output vectors/

Vectors trained:
  - persistence: "keep iterating on failing tests" vs "stop and declare done"
  - diversity: "use varied tools" vs "only use Read"
  - conciseness: "be brief and efficient" vs "be verbose and exploratory"
  - recovery: "try a different approach" vs "retry the same thing"
"""

import argparse
import json
import os
from pathlib import Path

# Control vector training pairs
# Each pair contrasts a desired behavior with its opposite
TRAINING_PAIRS = {
    "persistence": {
        "description": "Keep working until all tests pass vs stop at partial completion",
        "positive": [
            "The tests show 7 of 8 passing. Let me look at the failing test carefully and fix the remaining issue before declaring the task complete.",
            "I see one test is still failing. I need to read the error output, understand what's wrong, and make one more edit to fix it.",
            "Almost there - 90% of tests pass. Let me not stop now. I'll read the test output, identify the issue, and fix it.",
            "The task isn't done until all tests pass. Let me examine the failure and iterate once more.",
            "I notice the last test expects a specific output format. Let me edit the code to match and verify.",
        ],
        "negative": [
            "Most tests are passing so the implementation looks correct. The task is essentially complete.",
            "7 out of 8 tests pass which is a good result. The remaining failure might be a test issue.",
            "I've implemented the core functionality successfully. The solution handles the main cases.",
            "The code works for the primary use cases. I'll move on to the next task.",
            "Good progress - the implementation covers the key requirements. Done.",
        ],
    },
    "diversity": {
        "description": "Use varied tools appropriately vs rely on one tool",
        "positive": [
            "Let me first Glob to find relevant files, then Read the source code, Grep for the specific pattern, and then Edit to make the change.",
            "I should Read the test file to understand what's expected, then use Bash to run the tests, and Edit based on the results.",
            "Before editing, let me use Grep to find all occurrences of this pattern across the codebase so I don't miss any.",
            "I'll use Glob to discover the project structure, Read the key files, then Write a new file based on what I learned.",
            "Let me run the tests with Bash first to see the current state, then Read the failing test, then Edit the implementation.",
        ],
        "negative": [
            "Let me read the file again. I'll read it one more time. Let me read it again to check.",
            "I'll read the code. Now I'll read the other file. And read this file too.",
            "Reading the file... reading another file... reading the test file...",
            "Let me read src/main.ts. Now let me read src/main.ts again. Reading src/main.ts once more.",
            "I need to read the code. Read the code again. Still reading the code.",
        ],
    },
    "recovery": {
        "description": "Try a different approach when stuck vs retry the same thing",
        "positive": [
            "That approach didn't work. Let me step back and think about this differently. Instead of editing the function, maybe I should restructure the data flow.",
            "The error keeps recurring with this approach. Let me try a completely different algorithm instead of tweaking the same one.",
            "I've tried fixing this three times with the same strategy. Time to change tactics - let me read the test more carefully and reconsider my approach.",
            "This isn't working. Rather than making another small edit, let me rewrite this section with a different pattern.",
            "The same error keeps appearing. I need to understand the root cause rather than treating symptoms. Let me trace the data flow.",
        ],
        "negative": [
            "That edit didn't fix it. Let me try the same edit but with a slight variation.",
            "Still failing. I'll make another small change to the same line.",
            "The error persists. Let me adjust the same parameter slightly.",
            "Not working yet. I'll try the same approach one more time.",
            "Same error. Let me tweak the same function again.",
        ],
    },
    "conciseness": {
        "description": "Be efficient and focused vs verbose and wandering",
        "positive": [
            "I need to add a delete method to the store. Let me edit the file directly.",
            "The fix is to change line 42 from `nme` to `name`. One edit.",
            "Run tests, see what fails, fix it. Straightforward.",
            "Read the file, make the change, verify with tests. Done in three steps.",
            "The issue is a typo on line 5. Fixing it now.",
        ],
        "negative": [
            "Let me think about this carefully. First, I should consider the overall architecture. The system has several components that interact in complex ways. Before making any changes, I need to understand the full picture. Let me start by reading every file in the project to build a mental model.",
            "I'll begin by exploring the entire codebase structure. Let me list all files, then read each one systematically. After that, I'll analyze the dependencies between modules. Then I can start thinking about what changes might be needed. But first, let me read more files.",
            "This is an interesting problem. There are several approaches we could take. Let me outline the pros and cons of each approach before deciding. Approach 1 would be... Approach 2 could... Approach 3 might...",
            "Before I start coding, let me write a detailed plan of every step I'll take. Step 1: read all source files. Step 2: read all test files. Step 3: analyze patterns. Step 4: design solution. Step 5: implement. Step 6: test. Step 7: refine. Step 8: document.",
            "I want to make sure I understand the full context before making any changes. Let me trace through the entire execution path from entry point to output.",
        ],
    },
}


def create_training_data():
    """Format training pairs for repeng."""
    all_pairs = {}
    for vector_name, data in TRAINING_PAIRS.items():
        pairs = []
        for pos, neg in zip(data["positive"], data["negative"]):
            pairs.append({"positive": pos, "negative": neg})
        all_pairs[vector_name] = {
            "description": data["description"],
            "pairs": pairs,
        }
    return all_pairs


def train_vectors(model_name: str, output_dir: str):
    """Train control vectors using repeng."""
    try:
        from repeng import ControlVector, ControlModel
        from transformers import AutoModelForCausalLM, AutoTokenizer
        import torch
    except ImportError:
        print("repeng or transformers not available. Saving training data only.")
        training_data = create_training_data()
        os.makedirs(output_dir, exist_ok=True)
        with open(os.path.join(output_dir, "training_pairs.json"), "w") as f:
            json.dump(training_data, f, indent=2)
        print(f"Training data saved to {output_dir}/training_pairs.json")
        print("To train vectors, run with a transformers-compatible model.")
        return

    print(f"Loading model: {model_name}")
    tokenizer = AutoTokenizer.from_pretrained(model_name, trust_remote_code=True)
    model = AutoModelForCausalLM.from_pretrained(
        model_name,
        torch_dtype=torch.float16,
        device_map="auto",
        load_in_4bit=True,
        trust_remote_code=True,
    )

    # Wrap as control model (layers 15-30 typically most effective)
    n_layers = model.config.num_hidden_layers
    layer_start = n_layers // 3
    layer_end = 2 * n_layers // 3
    print(f"Using layers {layer_start}-{layer_end} of {n_layers}")

    control_model = ControlModel(model, list(range(layer_start, layer_end)))

    os.makedirs(output_dir, exist_ok=True)

    for vector_name, data in TRAINING_PAIRS.items():
        print(f"\nTraining vector: {vector_name}")
        print(f"  {data['description']}")

        # Create dataset
        dataset = []
        for pos, neg in zip(data["positive"], data["negative"]):
            dataset.append({
                "positive": tokenizer.apply_chat_template(
                    [{"role": "assistant", "content": pos}],
                    tokenize=False,
                ),
                "negative": tokenizer.apply_chat_template(
                    [{"role": "assistant", "content": neg}],
                    tokenize=False,
                ),
            })

        # Train
        vector = ControlVector.train(control_model, tokenizer, dataset)

        # Save
        vector_path = os.path.join(output_dir, f"{vector_name}.pt")
        torch.save(vector, vector_path)
        print(f"  Saved: {vector_path}")

    # Save metadata
    metadata = {
        "model": model_name,
        "layers": f"{layer_start}-{layer_end}",
        "vectors": list(TRAINING_PAIRS.keys()),
        "descriptions": {k: v["description"] for k, v in TRAINING_PAIRS.items()},
    }
    with open(os.path.join(output_dir, "metadata.json"), "w") as f:
        json.dump(metadata, f, indent=2)

    print(f"\nAll vectors saved to {output_dir}/")
    print("Use these with the governance system to steer model behavior at inference time.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Train governance control vectors")
    parser.add_argument("--model", default="Qwen/Qwen3.6-35B-A3B", help="HuggingFace model ID")
    parser.add_argument("--output", default="vectors/", help="Output directory")
    parser.add_argument("--data-only", action="store_true", help="Save training data without training")
    args = parser.parse_args()

    if args.data_only:
        training_data = create_training_data()
        os.makedirs(args.output, exist_ok=True)
        with open(os.path.join(args.output, "training_pairs.json"), "w") as f:
            json.dump(training_data, f, indent=2)
        print(f"Training data saved to {args.output}/training_pairs.json")
    else:
        train_vectors(args.model, args.output)
