import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ImageResponse } from 'next/og';
import { site } from '../src/site';
import { LogoMark } from './site-components';

export const alt = site.title;
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

const font = (file: string) => readFile(join(process.cwd(), 'assets/fonts', file));
// Custom fonts replace ImageResponse's default, so bring that default (Geist) along.
const sans = font('Geist-Regular.ttf');
// An ASCII subset of JetBrains Mono, so the install command reads as a shell line.
const mono = font('JetBrainsMono-Regular.ttf');

export default async function OpenGraphImage() {
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
              display: 'flex',
              alignSelf: 'flex-start',
              gap: 16,
              marginTop: 40,
              padding: '16px 24px',
              border: '1px solid #232b25',
              borderRadius: 12,
              background: '#121713',
              fontFamily: 'JetBrains Mono',
              fontSize: 26,
              lineHeight: 1.3,
              letterSpacing: 0,
              fontWeight: 400,
            }}
          >
            <span style={{ color: '#bff04d' }}>$</span>
            curl -fsSL https://juiced.codes/install.sh | sh
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
    {
      ...size,
      // The first font is the fallback for text without a matching fontFamily.
      fonts: [
        { name: 'Geist', data: await sans, weight: 400, style: 'normal' },
        { name: 'JetBrains Mono', data: await mono, weight: 400, style: 'normal' },
      ],
    },
  );
}
