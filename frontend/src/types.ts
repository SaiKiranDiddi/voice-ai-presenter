export interface StatContent {
  value: string
  label: string
  sub?: string
}

export interface ChartContent {
  title: string
  unit: string
  bars: { label: string; value: number; emphasis?: boolean }[]
  footnote?: string
}

export interface TableContent {
  columns: string[]
  rows: string[][]
  footnote?: string
}

export interface StepsContent {
  steps: { title: string; text: string }[]
}

export interface CalloutContent {
  title: string
  text: string
  bullets?: string[]
}

interface BlockBase {
  id: string
  talking_point: string
  facts: string[]
}

export type Block = BlockBase &
  (
    | { type: 'stat'; content: StatContent }
    | { type: 'chart'; content: ChartContent }
    | { type: 'table'; content: TableContent }
    | { type: 'steps'; content: StepsContent }
    | { type: 'callout'; content: CalloutContent }
  )

export interface Slide {
  id: string
  title: string
  nav: string
  subtitle?: string
  layout: string
  blocks: Block[]
}

/** How the agent presents this deck. The backend uses the rest of this section for the prompt. */
export interface DeckAgent {
  /** Who is listening, as the agent refers to them: "physician", "investor". */
  audience: string
}

export interface Deck {
  id: string
  /** What is being presented; shown as the brand in the top bar and on slides. */
  name: string
  /** Short line under the name, e.g. "Voice-led detail aid". */
  tagline?: string
  /** Small pill in the top bar, e.g. "Fictional product, demo only". Hidden when absent. */
  badge?: string
  disclaimer?: string
  agent: DeckAgent
  slides: Slide[]
}

export const DEFAULT_TAGLINE = 'Voice-led presentation'

export type FocusMode = 'presenting' | 'answering' | 'manual'

export type Transition = 'next' | 'prev' | 'jump' | 'none'

/** What the stage is showing: a slide, and optionally one highlighted block. */
export interface View {
  slideIndex: number
  blockId: string | null
  mode: FocusMode
  transition: Transition
}

export type AgentState =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'paused'
  | 'ended'
  | 'error'

export interface TranscriptLine {
  id: string
  role: 'user' | 'agent'
  text: string
  interrupted?: boolean
}

export interface AppConfig {
  session_max_seconds: number
  access_code_required: boolean
}

export interface SessionInfo {
  session_id: string
  client_secret: string
  model: string
  max_seconds: number
}

export interface LoggedEvent {
  type: string
  at_ms: number
  data: Record<string, unknown>
}
