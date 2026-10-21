import { ImageResponse } from 'next/og';

export const alt = 'Juiced — Claude Code, always on.';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: '64px 72px',
          background: '#0b0d0b',
          color: '#e4e9e4',
          fontFamily: 'sans-serif',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 18,
            fontSize: 36,
            fontWeight: 700,
          }}
        >
          <svg width="36" height="42" viewBox="0 0 26 30" fill="none">
            <path d="M5 10h16l-2 16H7L5 10Z" fill="#4eba65" />
            <path
              d="m14 3-2 7M5 7h16"
              stroke="#4eba65"
              strokeWidth="3"
              strokeLinecap="round"
            />
            <path d="m14 14-4 6h4l-1 4 5-7h-4l1-3Z" fill="#0b0d0b" />
          </svg>
          juiced
        </div>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            fontSize: 88,
            lineHeight: 1.05,
            letterSpacing: '-4px',
            fontWeight: 700,
          }}
        >
          <span>Claude Code,</span>
          <span style={{ color: '#6fd987' }}>always on.</span>
        </div>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            borderTop: '1px solid #1f2620',
            paddingTop: 28,
            fontSize: 24,
            color: '#a4afa5',
          }}
        >
          <span>Your terminal. A persistent cloud workspace.</span>
          <span style={{ color: '#6fd987' }}>juiced.codes</span>
        </div>
      </div>
    ),
    size,
  );
}
