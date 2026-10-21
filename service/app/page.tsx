import { InstallCommand } from './install-command';

// Placeholder until the install script ships.
const install = 'curl -fsSL https://juiced.codes/install.sh | sh';

export default function Home() {
  return (
    <div className="wrap">
      <main>
        <pre className="mark" aria-hidden="true">
          {' ▐▛███▜▌\n▝▜█████▛▘\n  ▘▘ ▝▝'}
        </pre>
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
