import { InstallCommand } from './install-command';

// Placeholder until the install script ships.
const install = 'curl -fsSL https://juiced.codes/install.sh | sh';

export default function Home() {
  return (
    <div className="wrap">
      <header>
        <a href="/" className="brand" aria-label="Juiced home">
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
        </a>
        <a className="mono" href="https://github.com/stepandel/juiced">
          github <span aria-hidden="true">↗</span>
        </a>
      </header>
      <main>
        <section className="hero" aria-labelledby="headline">
          <div>
            <h1 id="headline">
              Claude Code,
              <br />
              with more <em>juice.</em>
            </h1>
            <p className="intro">
              Juiced runs Claude Code in a private cloud workspace that you drive from your
              terminal. Close your laptop. Claude keeps working.
            </p>
            <InstallCommand command={install} />
            <p className="next mono">
              then run <code>juiced claude</code> in your project
            </p>
          </div>
          <div className="terminal mono" aria-label="Example of using Juiced from a terminal">
            <div className="terminal-top">
              <i className="light"></i>
              <i className="light"></i>
              <i className="light"></i>
              <span className="terminal-title">your-project — juiced</span>
            </div>
            <div className="terminal-body">
              <div className="command">
                <span className="dim">~/your-project $</span> juiced claude
              </div>
              <div className="turn">
                <span className="green">❯</span> add a settings page with a theme toggle
              </div>
              <div>
                <span className="green">●</span> Read <span className="dim">3 files</span>
              </div>
              <div>
                <span className="green">●</span> Write <span className="dim">app/settings/page.tsx</span>
              </div>
              <div className="turn">
                <span className="green">❯</span> /detach
              </div>
              <div className="dim indent">⎿ Detached. Claude is still working.</div>
              <div className="turn">
                <span className="dim">~/your-project $</span>{' '}
                <span className="cursor" aria-hidden="true"></span>
              </div>
            </div>
            <div className="terminal-foot">
              <span>your terminal</span>
              <span>
                <i className="live"></i> cloud workspace
              </span>
            </div>
          </div>
        </section>
        <section className="features" aria-labelledby="how">
          <h2 id="how" className="number mono">
            how it works
          </h2>
          <article>
            <span className="number mono">01</span>
            <h3>A workspace for your project</h3>
            <p>
              Your first <code>juiced claude</code> in a repo copies it to a private cloud workspace.
              Your code, Claude login and conversations stay there between runs.
            </p>
          </article>
          <article>
            <span className="number mono">02</span>
            <h3>A sandbox for every session</h3>
            <p>
              Claude Code runs in an isolated sandbox attached to that workspace. You drive it from
              your terminal, and it keeps going when you disconnect.
            </p>
          </article>
          <article>
            <span className="number mono">03</span>
            <h3>Shut down when idle</h3>
            <p>
              Once Claude is done, the sandbox shuts down. Run <code>juiced claude</code> again to
              pick up the same conversation.
            </p>
          </article>
          <article>
            <span className="number mono">04</span>
            <h3>Changes come back on your terms</h3>
            <p>
              Pull Claude's commits into your local repo when you're ready. Nothing changes on your
              laptop until you approve it.
            </p>
          </article>
        </section>
      </main>
      <footer className="mono">
        <span>juiced</span>
        <a href="https://cantelop.com">
          powered by cantelop <span aria-hidden="true">↗</span>
        </a>
      </footer>
    </div>
  );
}
