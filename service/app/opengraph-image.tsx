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
          background: '#0b0e0c',
          color: '#e8ece4',
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
          <LogoMark width={36} height={42} color="#bff04d" cutout="#0b0e0c" />
          juiced
        </div>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            fontSize: 88,
            lineHeight: 1.05,
            letterSpacing: '-4px',
            fontWeight: 500,
          }}
        >
          <span>Claude Code,</span>
          <span style={{ display: 'flex', gap: 24 }}>
            with more <span style={{ color: '#bff04d' }}>juice.</span>
          </span>
          <span
            style={{
              marginTop: 32,
              fontSize: 30,
              lineHeight: 1.3,
              letterSpacing: 0,
              fontWeight: 400,
              color: '#8b948a',
            }}
          >
            Your terminal. A persistent cloud workspace.
          </span>
        </div>
        {/* X draws the page title over the bottom-left corner, so keep it empty. */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            borderTop: '1px solid #232b25',
            paddingTop: 28,
            fontSize: 24,
            color: '#bff04d',
          }}
        >
          juiced.codes
        </div>
      </div>
    ),
    size,
  );
}
