import { InstallCommand } from './install-command';

// Placeholder until the install script ships.
const install = 'curl -fsSL https://juiced.codes/install.sh | sh';

export default function Home() {
  return (
    <div className="wrap">
      <main>
        <div className="brand">
          <svg className="mark" viewBox="0 0 26 30" fill="none" aria-hidden="true">
            <path d="M5 10h16l-2 16H7L5 10Z" fill="currentColor" />
            <path
              d="m14 3-2 7M5 7h16"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
            />
            <path d="m14 14-4 6h4l-1 4 5-7h-4l1-3Z" fill="var(--bg)" />
          </svg>
          juiced
        </div>
        <h1>
          Claude Code, with more <em>juice.</em>
        </h1>
        <p className="intro">
          Run Claude Code in an isolated cloud workspace. Keep your terminal, your code, and your
          Claude account.
        </p>
        <InstallCommand command={install} />
        <p className="next mono">
          then run <code>juiced claude</code> in your project
        </p>
      </main>
      <footer className="mono">
        <a href="https://github.com/stepandel/juiced">github</a>
        <span aria-hidden="true">·</span>
        <a href="https://cantelop.com">powered by cantelop</a>
      </footer>
    </div>
  );
}
