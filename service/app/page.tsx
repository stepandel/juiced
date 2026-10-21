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
              Run Claude Code in an isolated cloud workspace. Keep your terminal, your code, and
              your Claude account.
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
              <div>
                <b>Juiced</b> <span className="dim">· Claude Code on Cantelop</span>
              </div>
              <div className="dim">workspace your-project · session 7f3a</div>
              <div className="turn">
                <span className="green">❯</span> add a settings page with a theme toggle
              </div>
              <div>
                <span className="green">●</span> Read <span className="dim">3 files</span>
              </div>
              <div>
                <span className="green">●</span> Write <span className="dim">app/settings/page.tsx</span>
              </div>
              <div className="dim indent">⎿ +42 lines</div>
              <div>
                <span className="green">●</span> Done. The toggle saves to your account settings.
              </div>
              <div className="turn">
                <span className="green">❯</span> <span className="cursor" aria-hidden="true"></span>
              </div>
            </div>
            <div className="terminal-foot">
              <span>local terminal</span>
              <span>
                <i className="live"></i> cloud workspace
              </span>
            </div>
          </div>
        </section>
        <section className="features" aria-label="How Juiced works">
          <article>
            <span className="number mono">01 / stay in your flow</span>
            <h2>A familiar place to start.</h2>
            <p>
              Open your project and use Claude Code from your terminal. Juiced connects your local
              workflow to a persistent cloud workspace.
            </p>
          </article>
          <article>
            <span className="number mono">02 / make some room</span>
            <h2>Give your work its own space.</h2>
            <p>
              Each account gets an isolated workspace. Projects keep their own files, and
              conversations keep their context.
            </p>
          </article>
          <article>
            <span className="number mono">03 / bring it home</span>
            <h2>Your changes, on your terms.</h2>
            <p>
              Review and approve transfers between your laptop and the cloud. Keep local work safe
              while bringing completed changes back.
            </p>
          </article>
        </section>
      </main>
      <footer className="mono">
        <span>juiced · a little more room to build</span>
        <a href="https://cantelop.com">
          powered by cantelop <span aria-hidden="true">↗</span>
        </a>
      </footer>
    </div>
  );
}
