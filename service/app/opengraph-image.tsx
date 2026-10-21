import { ImageResponse } from 'next/og';
import { site } from '../src/site';
import { LogoMark } from './site-components';

export const alt = site.title;
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
          <LogoMark width={36} height={42} color="#4eba65" cutout="#0b0d0b" />
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
