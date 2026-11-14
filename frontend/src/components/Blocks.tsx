import type {
  Block,
  CalloutContent,
  ChartContent,
  StatContent,
  StepsContent,
  TableContent,
} from '../types'
import { CheckIcon } from './Icons'

function Stat({ content }: { content: StatContent }) {
  return (
    <>
      <p className="stat-value">{content.value}</p>
      <p className="stat-label">{content.label}</p>
      {content.sub && <p className="stat-sub">{content.sub}</p>}
    </>
  )
}

/** Bars hang down from a zero line, because the values are reductions. */
function Chart({ content }: { content: ChartContent }) {
  const width = 360
  const height = 232
  const baseline = 38
  const maxBar = 148
  const barWidth = 92
  const peak = Math.max(...content.bars.map((bar) => Math.abs(bar.value)))
  const slot = width / content.bars.length
  const gridlines = [0.25, 0.5, 0.75, 1].map((step) => baseline + step * maxBar)
  return (
    <>
      <div className="chart-head">
        <h3 className="block-title">{content.title}</h3>
        <span className="chart-unit">{content.unit}</span>
      </div>
      <svg className="chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={content.title}>
        <defs>
          <linearGradient id="bar-emphasis" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--accent-bright)" />
            <stop offset="1" stopColor="var(--accent-strong)" />
          </linearGradient>
        </defs>
        {gridlines.map((y) => (
          <line key={y} x1="12" x2={width - 12} y1={y} y2={y} className="chart-grid" />
        ))}
        <line x1="12" x2={width - 12} y1={baseline} y2={baseline} className="chart-axis" />
        {content.bars.map((bar, index) => {
          const barHeight = (Math.abs(bar.value) / peak) * maxBar
          const x = slot * index + (slot - barWidth) / 2
          const centre = x + barWidth / 2
          return (
            <g key={bar.label} className={bar.emphasis ? 'is-emphasis' : undefined}>
              <text x={centre} y={baseline - 13} className="chart-label">
                {bar.label}
              </text>
              <rect
                x={x}
                y={baseline}
                width={barWidth}
                height={barHeight}
                rx="7"
                className="chart-bar"
                style={{ animationDelay: `${200 + index * 140}ms` }}
              />
              <text x={centre} y={baseline + barHeight + 25} className="chart-value">
                {bar.value.toString().replace('-', '−')}
              </text>
            </g>
          )
        })}
      </svg>
      {content.footnote && <p className="footnote">{content.footnote}</p>}
    </>
  )
}

function Table({ content }: { content: TableContent }) {
  return (
    <>
      <table className="data-table">
        <thead>
          <tr>
            {content.columns.map((column, index) => (
              <th key={column}>{index === 1 ? <span className="th-pill">{column}</span> : column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {content.rows.map((row) => (
            <tr key={row[0]}>
              {row.map((cell, index) => (
                <td key={index}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {content.footnote && <p className="footnote">{content.footnote}</p>}
    </>
  )
}

function Steps({ content }: { content: StepsContent }) {
  return (
    <ol className="steps">
      {content.steps.map((step, index) => (
        <li key={step.title} className="step">
          <span className="step-number">{index + 1}</span>
          <h3 className="step-title">{step.title}</h3>
          <p className="step-text">{step.text}</p>
        </li>
      ))}
    </ol>
  )
}

function Callout({ content }: { content: CalloutContent }) {
  return (
    <>
      <h3 className="block-title">{content.title}</h3>
      <p className="callout-text">{content.text}</p>
      {content.bullets && (
        <ul className="callout-bullets">
          {content.bullets.map((bullet) => (
            <li key={bullet}>
              <CheckIcon />
              <span>{bullet}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

export function BlockBody({ block }: { block: Block }) {
  switch (block.type) {
    case 'stat':
      return <Stat content={block.content} />
    case 'chart':
      return <Chart content={block.content} />
    case 'table':
      return <Table content={block.content} />
    case 'steps':
      return <Steps content={block.content} />
    case 'callout':
      return <Callout content={block.content} />
  }
}
