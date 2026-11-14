import type {
  Block,
  CalloutContent,
  ChartContent,
  StatContent,
  StepsContent,
  TableContent,
} from '../types'

function Stat({ content }: { content: StatContent }) {
  return (
    <>
      <p className="stat-value">{content.value}</p>
      <p className="stat-label">{content.label}</p>
      {content.sub && <p className="stat-sub">{content.sub}</p>}
    </>
  )
}

function Chart({ content }: { content: ChartContent }) {
  const width = 360
  const baseline = 40
  const maxBar = 150
  const barWidth = 96
  const peak = Math.max(...content.bars.map((bar) => Math.abs(bar.value)))
  const slot = width / content.bars.length
  return (
    <>
      <h3 className="block-title">{content.title}</h3>
      <svg className="chart" viewBox={`0 0 ${width} 240`} role="img" aria-label={content.title}>
        <line x1="16" x2={width - 16} y1={baseline} y2={baseline} className="chart-axis" />
        {content.bars.map((bar, index) => {
          const height = (Math.abs(bar.value) / peak) * maxBar
          const x = slot * index + (slot - barWidth) / 2
          const centre = x + barWidth / 2
          return (
            <g key={bar.label}>
              <text x={centre} y={baseline - 14} className="chart-label">
                {bar.label}
              </text>
              <rect
                x={x}
                y={baseline}
                width={barWidth}
                height={height}
                rx="6"
                className={bar.emphasis ? 'chart-bar chart-bar--emphasis' : 'chart-bar'}
                style={{ animationDelay: `${index * 120}ms` }}
              />
              <text x={centre} y={baseline + height + 26} className="chart-value">
                {bar.value.toString().replace('-', '−')} {content.unit}
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
            {content.columns.map((column) => (
              <th key={column}>{column}</th>
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
            <li key={bullet}>{bullet}</li>
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
