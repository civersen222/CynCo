/**
 * VibeController — orchestrates the continuous vibe loop.
 *
 * Drives the VibeLoopEngine state machine, generates questions via sideQuery,
 * delegates BUILD to ConversationLoop, creates completion reports with analogies.
 */

import { VibeLoopEngine } from './engine.js'
import type { VibeMode, VibeEvent } from './types.js'
import type { ConversationLoop } from '../bridge/conversationLoop.js'
import { ProjectIndexer } from '../index/indexer.js'

const MAX_QUESTIONS = 30  // Safety valve only — LLM says READY when done

/** System prompt for question generation — ported from ProjectWizard's BRAINSTORM_SYSTEM. */
const QUESTION_SYSTEM = [
  'You are an expert product designer helping someone build software.',
  'When the user references existing products, games, apps, or services, you KNOW',
  'those products deeply — their core mechanics, UX patterns, what makes them great,',
  'and what specific features define them.',
  '',
  'Your job: ask ONE focused question about a SPECIFIC design decision, drawing on',
  'your knowledge of the referenced products. Don\'t ask generic questions like',
  '"what platform?" — ask about the specific mechanics and features that matter.',
  '',
  'For existing codebases, reference the ACTUAL files and code you see.',
  'Don\'t ask about features that are already implemented — ask about what\'s MISSING',
  'or what the user wants to CHANGE.',
  '',
  'Format your response EXACTLY like this:',
  'Your question here?',
  'A) First option',
  'B) Second option',
  'C) Third option',
  '',
  'Rules: ONE question, ONE topic, 2-3 options. No explanations or reasoning.',
  'The user is not a programmer — use plain language.',
  'If you have enough information, respond with just READY.',
].join('\n')

export type VibeControllerOptions = {
  emit: (event: VibeEvent | Record<string, unknown>) => void
  sideQuery: (prompt: string) => Promise<string>
  loop: ConversationLoop
}

export class VibeController {
  private engine: VibeLoopEngine
  private emitFn: (event: VibeEvent | Record<string, unknown>) => void
  private sideQuery: (prompt: string) => Promise<string>
  private loop: ConversationLoop
  private questionCounter = 0
  private userDescription = ''
  private answers: { question: string; answer: string }[] = []
  private lastSuggestion = ''
  private projectSummary = ''
  private projectContext = ''  // Raw file content for LLM context
  private indexer: ProjectIndexer | null = null

  constructor(opts: VibeControllerOptions) {
    this.emitFn = opts.emit
    this.sideQuery = opts.sideQuery
    this.loop = opts.loop
    this.engine = new VibeLoopEngine((event) => this.emitFn(event))
  }

  get state() {
    return this.engine.state
  }

  get difficulty() {
    return this.engine.difficulty
  }

  async start(mode: VibeMode, description?: string): Promise<void> {
    this.userDescription = description ?? ''
    this.answers = []
    this.questionCounter = 0
    this.projectSummary = ''
    this.projectContext = ''
    this.engine.start(mode, description)

    // Auto-approve all tools in project/vibe mode — no approval popups
    this.loop.setApproveAll(true)

    // ALWAYS scan the project directory — the model needs to know what exists
    await this.scanProject()

    // Set baselines so no dimension starts at 0 (min-of-4 kills overall otherwise)
    if (this.projectSummary) {
      // Existing project — we know a lot already
      this.engine.updateConfidence('purpose', 60, 'Project scanned — we know what exists')
      this.engine.updateConfidence('mechanics', 40, 'Can infer patterns from existing code')
      this.engine.updateConfidence('integration', 50, 'File structure identified')
      this.engine.updateConfidence('ambiguity', 40, 'Existing project reduces unknowns')
    } else if (this.userDescription) {
      // New project — user described something, set minimum baselines
      this.engine.updateConfidence('purpose', 20, 'Initial description provided')
      this.engine.updateConfidence('mechanics', 10, 'Some mechanics implied')
      this.engine.updateConfidence('integration', 10, 'Baseline')
      this.engine.updateConfidence('ambiguity', 10, 'Baseline')
    }

    // ALWAYS ask the user what they want before generating LLM questions
    if (this.projectSummary) {
      // Existing project — ask what they want to do
      const questionId = `q-${++this.questionCounter}`
      const firstQ = mode === 'fix'
        ? `I found this project:\n\n${this.projectSummary}\n\nWhat's not working right? Describe the bug or problem.`
        : `I found this project:\n\n${this.projectSummary}\n\nWhat would you like to do with it?`
      this.emitFn({
        type: 'vibe.question',
        questionId,
        text: firstQ,
        options: ['Add a new feature', 'Improve something existing', 'Just finish what\'s started', 'Something else (type below)'],
      })
    } else {
      // No project files — ask what to build
      const questionId = `q-${++this.questionCounter}`
      this.emitFn({
        type: 'vibe.question',
        questionId,
        text: 'What would you like to build? Describe your idea.',
        options: [],
      })
    }
  }

  async handleAnswer(questionId: string, answer: string): Promise<void> {
    // Special case: confirmation question
    if (questionId === 'confirm') {
      if (answer.toLowerCase().includes('yes') || answer === 'A' || answer === 'a') {
        await this.executeBuild()
      } else {
        await this.generateQuestion()
      }
      return
    }

    // If the answer is a substantive instruction (not just A/B/C), treat it as a BUILD directive
    const isShortPick = /^[a-dA-D]$/i.test(answer.trim()) || answer.trim().length < 10
    if (!isShortPick) {
      // User gave a real directive — BUILD IT, don't ask more questions
      this.userDescription = answer
      console.log(`[vibe] User directive — going straight to BUILD: "${answer.slice(0, 80)}"`)
      this.answers.push({ question: 'User directive', answer })
      this.writePlanFile()
      await this.executeBuild()
      return
    }

    // Short picks (A/B/C) — store and continue Q&A
    const lastQuestion = this.answers.length > 0
      ? this.answers[this.answers.length - 1]?.question ?? ''
      : this.userDescription
    this.answers.push({ question: lastQuestion, answer })

    // Persist Q&A to plan file so the LLM can reference it and not repeat questions
    this.writePlanFile()

    // Update confidence bar visually — each answer = +1 step toward threshold
    const answeredCount = this.answers.filter(a => a.answer).length
    const maxQ = this.getMaxQuestionsForDifficulty()
    const pct = Math.min(100, Math.round((answeredCount / maxQ) * 100))
    this.engine.updateConfidence('purpose', pct, answer.slice(0, 60))
    this.engine.updateConfidence('mechanics', pct, '')
    this.engine.updateConfidence('integration', pct, '')
    this.engine.updateConfidence('ambiguity', pct, '')

    // Safety valve — auto-transition after max questions for this difficulty
    if (this.questionCounter >= MAX_QUESTIONS) {
      console.log(`[vibe] Max questions (${MAX_QUESTIONS}) reached — auto-transitioning to build`)
      await this.executeBuild()
      return
    }

    // Let the LLM decide when it has enough info (says READY)
    await this.generateQuestion()
  }

  /** How many questions the LLM should aim for, based on task difficulty. */
  /** Target question count by difficulty — guides the LLM, not a hard limit. */
  private getMaxQuestionsForDifficulty(): number {
    switch (this.engine.difficulty) {
      case 'trivial': return 1
      case 'simple': return 3
      case 'medium': return 6
      case 'complex': return 12
      case 'massive': return 20
      default: return 6
    }
  }

  async handleAction(action: 'accept_suggestion' | 'something_else' | 'fix' | 'done' | 'skip' | 'just_build', text?: string): Promise<void> {
    this.engine.handleAction(action)

    switch (action) {
      case 'accept_suggestion':
        this.userDescription = this.lastSuggestion
        this.answers = []
        await this.generateQuestion()
        break
      case 'something_else':
      case 'fix':
        this.userDescription = text ?? ''
        this.answers = []
        await this.generateQuestion()
        break
      case 'just_build':
        await this.executeBuild()
        break
      case 'done':
        break
      case 'skip':
        await this.generateQuestion()
        break
    }
  }

  async handleEscalationResponse(requestId: string, action: 'fix' | 'skip' | 'explain'): Promise<void> {
    this.engine.handleEscalationResponse(action)

    switch (action) {
      case 'fix':
        await this.executeBuild()
        break
      case 'skip':
        this.emitFn({
          type: 'vibe.question',
          questionId: `q-${++this.questionCounter}`,
          text: 'We skipped that issue. What would you like to work on next?',
          options: [],
        })
        break
      case 'explain':
        this.emitFn({
          type: 'vibe.question',
          questionId: `q-${++this.questionCounter}`,
          text: 'Tell me more about what you need, and I\'ll try a different approach.',
          options: [],
        })
        break
    }
  }

  // ─── Private: Question Generation ──────────────────────────────

  private async generateQuestion(): Promise<void> {
    const answeredCount = this.answers.filter(a => a.answer).length
    const targetQuestions = this.getMaxQuestionsForDifficulty()

    // Read the plan file from disk — this is the source of truth for what's been decided
    const planContent = this.readPlanFile()

    // Query index for code relevant to current discussion
    const lastTopic = this.answers.filter(a => a.answer).slice(-2)
      .map(a => `${a.question} ${a.answer}`).join(' ')
    const indexQuery = lastTopic || this.userDescription
    const indexContext = await this.queryProjectIndex(indexQuery, 8)
    const codeContext = indexContext
      ? `\n--- Relevant existing code (from index) ---\n${indexContext}\n--- End code ---\n`
      : (this.projectContext
        ? `\n--- Existing codebase ---\n${this.projectContext}\n--- End codebase ---\n`
        : '')

    // Build explicit list of topics already asked about — local LLMs need this spelled out
    const askedTopics = this.answers
      .filter(a => a.answer && a.question)
      .map(a => `- ${a.question.slice(0, 80)}`)
      .join('\n')
    const topicBlock = askedTopics
      ? `\nTOPICS ALREADY ASKED (DO NOT REPEAT ANY OF THESE):\n${askedTopics}\n`
      : ''

    const prompt = [
      QUESTION_SYSTEM,
      '',
      `--- Context ---`,
      `Project: ${this.userDescription}`,
      codeContext,
      planContent
        ? `\n--- DECISIONS ALREADY MADE ---\n${planContent}\n--- END DECISIONS ---\n`
        : '',
      topicBlock,
      `This is a ${this.engine.difficulty ?? 'medium'} task. Ask about ${targetQuestions} questions total.`,
      `You have asked ${answeredCount} so far. ${answeredCount >= targetQuestions ? 'You should have enough — say READY unless something critical is missing.' : `Ask ${targetQuestions - answeredCount} more.`}`,
      '',
      `RULES:`,
      `1. Do NOT repeat any question from TOPICS ALREADY ASKED above`,
      `2. Ask about a DIFFERENT aspect of the project`,
      `3. If you cannot think of a new topic, say READY`,
      '',
      `Ask the next clarifying question (or say READY):`,
    ].join('\n')

    try {
      const raw = await this.sideQuery(prompt)
      const parsed = this.parseQuestion(raw)

      if (parsed.ready) {
        await this.executeBuild()
        return
      }

      // Always add "Something else" option
      if (parsed.options.length > 0) {
        parsed.options.push('Something else (type below)')
      }

      const questionId = `q-${++this.questionCounter}`
      this.answers.push({ question: parsed.question, answer: '' })
      this.emitFn({
        type: 'vibe.question',
        questionId,
        text: parsed.question,
        options: parsed.options,
      })
    } catch (e) {
      const questionId = `q-${++this.questionCounter}`
      this.emitFn({
        type: 'vibe.question',
        questionId,
        text: 'Can you tell me more about what you want to build?',
        options: [],
      })
    }
  }

  private parseQuestion(raw: string): { question: string; options: string[]; ready: boolean } {
    const text = raw.trim()
    if (text.toUpperCase() === 'READY') {
      return { question: '', options: [], ready: true }
    }

    const lines = text.split('\n')
    const question = lines[0].trim()
    const options: string[] = []

    for (const line of lines.slice(1)) {
      const trimmed = line.trim()
      const match = trimmed.match(/^[A-Da-d][).]\s*(.+)/)
      if (match) {
        options.push(match[1].trim())
      }
    }

    return { question, options, ready: false }
  }

  // ─── Private: Plan File Persistence ─────────────────────────────

  /** Write Q&A decisions with locked D-XX IDs to .cynco-plan.md */
  private writePlanFile(): void {
    const fs = require('fs')
    const path = require('path')
    const cwd = process.cwd()
    const planPath = path.join(cwd, '.cynco-plan.md')

    const lines = [
      `# Project Plan — ${this.userDescription.slice(0, 80)}`,
      '',
      `## Locked Decisions (DO NOT simplify, defer, or change these)`,
      '',
    ]

    let dIdx = 1
    for (const qa of this.answers) {
      if (qa.answer) {
        const dId = `D-${String(dIdx).padStart(2, '0')}`
        lines.push(`- **${dId}**: ${qa.question} → ${qa.answer}`)
        dIdx++
      }
    }

    try {
      fs.writeFileSync(planPath, lines.join('\n'))
      console.log(`[vibe] Plan file written: ${planPath} (${dIdx - 1} locked decisions)`)
    } catch (e) {
      console.log(`[vibe] Failed to write plan file: ${e}`)
    }
  }

  /** Write project state after build for cross-session persistence. */
  private writeStateFile(filesModified: string[]): void {
    const fs = require('fs')
    const path = require('path')
    const cwd = process.cwd()
    const statePath = path.join(cwd, '.cynco-state.md')

    const planContent = this.readPlanFile()
    const lines = [
      `# Project State — ${new Date().toISOString().slice(0, 16)}`,
      '',
      `## Task: ${this.userDescription.slice(0, 120)}`,
      '',
      `## Files Modified`,
      ...filesModified.map(f => `- ${f}`),
      '',
      planContent ? `## Decisions\n${planContent.split('\n').filter(l => l.startsWith('- **D-')).join('\n')}` : '',
      '',
      `## Status: Build complete`,
    ]

    try {
      fs.writeFileSync(statePath, lines.join('\n'))
      console.log(`[vibe] State file written: ${statePath}`)
    } catch {}
  }

  /** Read state file for cross-session context. */
  private readStateFile(): string {
    const fs = require('fs')
    const path = require('path')
    const statePath = path.join(process.cwd(), '.cynco-state.md')
    try {
      if (fs.existsSync(statePath)) return fs.readFileSync(statePath, 'utf-8')
    } catch {}
    return ''
  }

  /** Read the plan file from disk. */
  private readPlanFile(): string {
    const fs = require('fs')
    const path = require('path')
    const cwd = process.cwd()
    const planPath = path.join(cwd, '.cynco-plan.md')

    try {
      if (fs.existsSync(planPath)) {
        return fs.readFileSync(planPath, 'utf-8')
      }
    } catch {}
    return ''
  }

  /** Query the project index for relevant code. Falls back to empty if no index. */
  private async queryProjectIndex(query: string, topK = 5): Promise<string> {
    if (!this.indexer) {
      try {
        this.indexer = new ProjectIndexer(process.cwd())
        console.log(`[vibe] Index opened: ${this.indexer.getSummary()}`)
      } catch (e) {
        console.log(`[vibe] Index open failed: ${e}`)
        return ''
      }
    }
    try {
      const results = await this.indexer.query({ query, topK })
      const formatted = this.indexer.formatResults(results)
      console.log(`[vibe] Index query "${query.slice(0, 50)}": ${results.length} results, ${formatted.length} chars`)
      return formatted
    } catch (e) {
      console.log(`[vibe] Index query failed: ${e}`)
      return ''
    }
  }

  /** Check if the user's task description warrants external research before building. */
  private async shouldResearch(description: string): Promise<boolean> {
    if (!description || description.trim().length < 10) return false

    // Check if research already exists in the index for this topic
    const existing = await this.queryProjectIndex(description, 3)
    if (existing) {
      // Check if any results are research chunks (contain citation-like patterns)
      const hasResearch = existing.includes('[Source:') || existing.includes('— Source:')
      if (hasResearch) {
        console.log('[vibe] Existing research found in index — skipping research phase')
        return false
      }
    }

    try {
      const prompt = [
        'Does this task require external research (unfamiliar APIs, libraries, patterns,',
        'best practices, academic references) before implementation?',
        'Consider: if a developer has never worked with the technologies mentioned,',
        'would they need to look things up first?',
        '',
        `Task: "${description}"`,
        '',
        'Answer YES or NO only.',
      ].join('\n')
      const answer = await this.sideQuery(prompt)
      return answer.trim().toUpperCase().startsWith('YES')
    } catch {
      return false
    }
  }

  // ─── Private: Summarize Understanding ──────────────────────────

  private async summarizeUnderstanding(): Promise<string> {
    const answersContext = this.answers
      .filter(a => a.answer)
      .map(a => `Q: ${a.question}\nA: ${a.answer}`)
      .join('\n\n')

    const prompt = [
      `Summarize what you understand about this project in 3-5 bullet points.`,
      `Use plain language, no jargon.`,
      '',
      `Original request: "${this.userDescription}"`,
      '',
      `Q&A session:\n${answersContext}`,
    ].join('\n')

    try {
      return await this.sideQuery(prompt)
    } catch {
      return `Build: ${this.userDescription}`
    }
  }

  // ─── Private: BUILD Phase ──────────────────────────────────────

  async executeBuild(buildPromptOverride?: string): Promise<void> {
    // Check if research would help before building
    if (!buildPromptOverride && this.userDescription) {
      const needsResearch = await this.shouldResearch(this.userDescription)
      if (needsResearch) {
        console.log(`[vibe] Research needed — injecting research context before build`)
        const researchPrompt = [
          `Before implementing, research the following topic using WebSearch:`,
          `"${this.userDescription}"`,
          '',
          `Search for relevant libraries, APIs, patterns, and best practices.`,
          `Use the engine parameter to target specific search engines:`,
          `- engine:"arxiv" for academic papers`,
          `- engine:"github" for code examples and libraries`,
          `- engine:"wikipedia" for background concepts`,
          '',
          `Summarize your findings, then proceed to implementation.`,
        ].join('\n')
        await this.loop.handleUserMessage(researchPrompt)
      }
    }

    this.engine.transitionToBuild()

    // Auto-approve all tools during project BUILD — no approval popups
    this.loop.setApproveAll(true)

    const buildPrompt = buildPromptOverride ?? await this.buildTaskPrompt()

    await this.loop.handleUserMessage(buildPrompt)

    // Restore approval gating after build
    this.loop.setApproveAll(false)

    const govReport = this.loop.getGovernanceReport()
    if (govReport.stuckTurns >= 3) {
      const problem = await this.generateEscalationSummary()
      this.engine.escalate(
        problem.explanation,
        problem.tried,
        problem.proposal,
      )
    } else {
      await this.generateCompletionReport()
    }
  }

  private async buildTaskPrompt(): Promise<string> {
    const projectCtx = this.projectSummary
      ? `\nExisting project context:\n${this.projectSummary}\n`
      : ''

    // Query index for code relevant to the build task
    let indexSection = ''
    try {
      const buildContext = await this.queryProjectIndex(this.userDescription, 10)
      if (buildContext) {
        indexSection = `\n--- Relevant existing code ---\n${buildContext}\n--- End code ---\n`
      }
    } catch {}

    // Use the plan file as the authoritative design document
    const planContent = this.readPlanFile()

    // Include prior state for cross-session context
    const stateContent = this.readStateFile()

    return [
      `Build the following for the user. Work autonomously — do not ask questions.`,
      projectCtx,
      indexSection,
      stateContent ? `\n--- Prior Session State ---\n${stateContent}\n--- End State ---\n` : '',
      `Request: ${this.userDescription}`,
      planContent ? `\n--- Locked Decisions (D-XX) ---\n${planContent}\n--- End Decisions ---\n\nYou MUST implement every D-XX decision exactly as stated. Do NOT simplify, defer, stub out, or change any locked decision.` : '',
      '',
      `Requirements:`,
      `- Read existing files first to understand the codebase`,
      `- Implement all D-XX decisions exactly`,
      `- BUGS/IMPORTS/DEPS: Fix immediately without asking`,
      `- ARCHITECTURAL CHANGES: Stop and ask the user first`,
      `- Create or modify files as needed`,
      `- Make it work end-to-end`,
      `- Commit your work when done`,
    ].filter(Boolean).join('\n')
  }

  // ─── Private: Completion Report ────────────────────────────────

  private async generateCompletionReport(): Promise<void> {
    const handoff = this.loop.buildHandoff()
    const filesChanged = handoff.files_modified

    // GSD: Write project state for cross-session persistence
    this.writeStateFile(filesChanged)

    // GSD: Goal-backward verification — verify outcome, not just task completion
    try {
      const verifyPrompt = [
        `Task was: "${this.userDescription}"`,
        `Files modified: ${filesChanged.join(', ') || 'none'}`,
        '',
        `Verify 3 levels:`,
        `1. TRUTH: Is the goal achieved? Can the user do what they asked?`,
        `2. EXISTS: Do all necessary files, functions, classes exist?`,
        `3. WIRED: Are they imported, called, and connected? No dead code?`,
        '',
        `Reply with PASS if all 3 pass, or FAIL: <what needs fixing>`,
      ].join('\n')
      const verification = await this.sideQuery(verifyPrompt)
      if (verification.toUpperCase().includes('FAIL')) {
        console.log(`[vibe] Verification FAILED — steering back to build: ${verification.slice(0, 100)}`)
        // GSD→VSM: pain signal — goal not achieved
        this.loop.reportVerification(false, verification.slice(0, 200))
        // Steer back to build with the fix list
        await this.loop.handleUserMessage(
          `VERIFICATION FAILED. Fix these issues:\n${verification}\n\nFix each issue, test, and verify.`
        )
      } else {
        // GSD→VSM: pleasure signal — goal achieved
        this.loop.reportVerification(true)
      }
    } catch {}

    const analogyPrompt = [
      `Explain what was just built in 2-3 sentences using a relatable analogy.`,
      `The user asked for: "${this.userDescription}"`,
      `Files created/modified: ${filesChanged.join(', ') || 'none tracked'}`,
      `Use plain language a non-programmer would understand.`,
      `Start with "Think of it like..." or similar.`,
    ].join('\n')

    let analogy: string
    try {
      analogy = await this.sideQuery(analogyPrompt)
    } catch {
      analogy = `I built what you asked for: ${this.userDescription}`
    }

    const suggestionPrompt = [
      `You just built: "${this.userDescription}"`,
      `What would a contractor logically suggest as the next step?`,
      `Give ONE concrete suggestion in plain language, 1-2 sentences.`,
      `Think about what would make this more complete or useful.`,
    ].join('\n')

    let suggestion: string
    try {
      suggestion = await this.sideQuery(suggestionPrompt)
    } catch {
      suggestion = 'Would you like to add any improvements or work on something new?'
    }

    this.lastSuggestion = suggestion

    this.engine.completeTask(
      this.userDescription.slice(0, 80),
      analogy.trim(),
      filesChanged,
      suggestion.trim(),
    )
  }

  // ─── Private: Escalation ───────────────────────────────────────

  private async generateEscalationSummary(): Promise<{
    explanation: string
    tried: string[]
    proposal: string
  }> {
    const prompt = [
      `The AI got stuck while building: "${this.userDescription}"`,
      `Explain the problem in plain language (1-2 sentences, no jargon).`,
      `List 2 things that were tried.`,
      `Suggest what to do next.`,
      '',
      `Format:`,
      `problem: <plain language explanation>`,
      `tried1: <first approach>`,
      `tried2: <second approach>`,
      `proposal: <suggestion>`,
    ].join('\n')

    try {
      const raw = await this.sideQuery(prompt)
      const lines = raw.split('\n')
      let explanation = 'I ran into a problem while building this.'
      const tried: string[] = []
      let proposal = 'Let me try a different approach.'

      for (const line of lines) {
        const pm = line.match(/problem:\s*(.+)/i)
        if (pm) explanation = pm[1].trim()
        const t1 = line.match(/tried1:\s*(.+)/i)
        if (t1) tried.push(t1[1].trim())
        const t2 = line.match(/tried2:\s*(.+)/i)
        if (t2) tried.push(t2[1].trim())
        const pr = line.match(/proposal:\s*(.+)/i)
        if (pr) proposal = pr[1].trim()
      }

      return { explanation, tried, proposal }
    } catch {
      return {
        explanation: 'I ran into a problem while building this.',
        tried: ['Attempted the standard approach', 'Tried an alternative method'],
        proposal: 'Let me try a different approach.',
      }
    }
  }

  // ─── Private: Project Scan ─────────────────────────────────────

  private async scanProject(): Promise<void> {
    const fs = require('fs')
    const path = require('path')
    const cwd = process.cwd()

    // Walk the filesystem to find real files
    const files: string[] = []
    const walk = (dir: string, depth: number) => {
      if (depth > 3) return
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true })
        for (const entry of entries) {
          const name = entry.name
          if (name.startsWith('.') || name === 'node_modules' || name === '__pycache__' ||
              name === 'venv' || name === '.venv' || name === 'dist' || name === 'build') continue
          const full = path.join(dir, name)
          if (entry.isDirectory()) {
            walk(full, depth + 1)
          } else {
            files.push(path.relative(cwd, full))
          }
        }
      } catch { /* permission errors etc */ }
    }
    walk(cwd, 0)

    if (files.length === 0) {
      return
    }

    // Count extensions to detect languages
    const extCounts: Record<string, number> = {}
    for (const f of files) {
      const ext = path.extname(f).toLowerCase()
      if (ext) extCounts[ext] = (extCounts[ext] ?? 0) + 1
    }
    const languages = Object.entries(extCounts)
      .sort((a, b) => (b[1] as number) - (a[1] as number))
      .slice(0, 5)
      .map(([ext]) => ext)

    // Read key config files for context
    const keyFiles = [
      'README.md', 'readme.md', 'README.rst',
      'package.json', 'pyproject.toml', 'Cargo.toml',
      'go.mod', 'setup.py', 'requirements.txt',
      'Makefile', 'CMakeLists.txt', 'pom.xml',
    ]
    let rawContext = ''
    for (const kf of keyFiles) {
      const fp = path.join(cwd, kf)
      if (fs.existsSync(fp)) {
        try {
          const content = fs.readFileSync(fp, 'utf-8').slice(0, 500)
          rawContext += `\n--- ${kf} ---\n${content}\n`
        } catch { /* unreadable */ }
      }
    }

    // Read source files for deeper context
    const sourceExts = new Set(['.py', '.ts', '.tsx', '.js', '.jsx', '.rs', '.go', '.java', '.c', '.cpp', '.rb', '.cs'])
    const sourceFiles = files.filter(f => sourceExts.has(path.extname(f).toLowerCase())).slice(0, 8)
    for (const sf of sourceFiles) {
      try {
        const content = fs.readFileSync(path.join(cwd, sf), 'utf-8').slice(0, 400)
        rawContext += `\n--- ${sf} ---\n${content}\n`
      } catch { /* unreadable */ }
    }

    // Store raw context for question generation prompts
    this.projectContext = `Files (${files.length} total): ${files.slice(0, 40).join(', ')}\n${rawContext}`

    // Generate human-friendly summary via sideQuery
    const summaryPrompt = [
      `Based on these real project files, describe what this project is and does.`,
      `Write 2-3 sentences in plain language a non-programmer would understand.`,
      `Be specific — name the actual project, its purpose, and key features you see.`,
      '',
      this.projectContext,
    ].join('\n')

    try {
      const summary = await this.sideQuery(summaryPrompt)
      this.projectSummary = summary.trim()
    } catch {
      this.projectSummary = `Project with ${files.length} files (${languages.join(', ')}). Key files: ${files.slice(0, 10).join(', ')}`
    }

    this.emitFn({
      type: 'vibe.project_scanned',
      summary: this.projectSummary,
      fileCount: files.length,
      languages,
    })

    console.log(`[vibe] Scanned project: ${files.length} files, ${languages.join('/')}, summary: ${this.projectSummary.slice(0, 100)}`)
  }
}
