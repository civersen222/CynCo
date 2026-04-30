import type { WorkflowDefinition } from '../types.js'

export const tddWorkflow: WorkflowDefinition = {
  name: 'tdd',
  displayName: 'Test-Driven Development',
  description: 'Red-green-refactor TDD cycle: write a failing test, implement minimum code to pass, then refactor.',
  initialPhase: 'write_test',
  phases: {
    write_test: {
      name: 'write_test',
      instruction: 'Write a failing test only. Do not implement any production code yet. Focus on the desired behavior and write the test first. Use Read, Glob, and Grep to understand the codebase, then Write or Edit the test file.',
      allowedTools: ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'SubAgent', 'CollectAgent'],
      gate: { type: 'model_done' },
      transitions: ['run_test_fail'],
    },
    run_test_fail: {
      name: 'run_test_fail',
      instruction: 'Run the test suite and confirm the new test FAILS. This verifies the test is actually testing something. If the test passes unexpectedly, go back to write_test to revise it.',
      allowedTools: ['Bash', 'Read', 'SubAgent', 'CollectAgent'],
      gate: { type: 'tool_output', tool: 'Bash', pattern: '[Ff][Aa][Ii][Ll]' },
      transitions: ['implement', 'write_test'],
    },
    implement: {
      name: 'implement',
      instruction: 'Write the minimum production code needed to make the failing test pass. Do not over-engineer. Focus only on making the test green. Use Read, Glob, and Grep to understand where to make changes.',
      allowedTools: ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'SubAgent', 'CollectAgent'],
      gate: { type: 'model_done' },
      transitions: ['run_test_pass'],
    },
    run_test_pass: {
      name: 'run_test_pass',
      instruction: 'Run the test suite and confirm the test now PASSES. All previously passing tests must still pass. If tests fail, go back to implement to fix the code.',
      allowedTools: ['Bash', 'Read', 'SubAgent', 'CollectAgent'],
      gate: { type: 'tool_output', tool: 'Bash', pattern: '[Pp][Aa][Ss][Ss]' },
      transitions: ['refactor', 'implement'],
    },
    refactor: {
      name: 'refactor',
      instruction: 'Clean up the code without changing behavior. Remove duplication, improve naming, simplify logic. Run tests after each refactor to ensure they still pass. Commit when done, or start the next TDD cycle.',
      gate: { type: 'model_done' },
      transitions: ['write_test', 'done'],
    },
  },
}
