import { useLayoutEffect, useRef, useState } from 'react'

/**
 * SVG stroke-outlined text, ported from the original. Renders fill over a
 * rounded stroke (paintOrder="stroke") in Kreon, with a soft drop shadow —
 * this is what gives the card names / costs their game-like outlined look.
 */
export function OutlinedText({
  text,
  fill,
  stroke,
  fontSize,
  fontWeight
}: {
  text: string | number
  fill: string
  stroke: string
  fontSize: number
  fontWeight?: number
}): JSX.Element {
  const textRef = useRef<SVGTextElement>(null)
  const [width, setWidth] = useState(0)
  const strokeWidth = Math.max(3.5, Math.round(fontSize * 0.22))
  const height = Math.ceil(fontSize * 1.4)

  useLayoutEffect(() => {
    const measured = textRef.current?.getComputedTextLength?.() ?? 0
    setWidth(Math.ceil(measured))
  }, [text, fontSize])

  return (
    <svg width={width + strokeWidth * 2} height={height} style={{ display: 'block', overflow: 'visible' }}>
      <text
        ref={textRef}
        x={strokeWidth}
        y={height / 2}
        dominantBaseline="central"
        textAnchor="start"
        fill={fill}
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
        strokeLinecap="round"
        paintOrder="stroke"
        fontFamily={'"Kreon", sans-serif'}
        fontWeight={fontWeight ?? 700}
        fontSize={fontSize}
        filter="drop-shadow(1px 1px 0 rgba(0, 0, 0, 0.25))"
      >
        {text}
      </text>
    </svg>
  )
}
