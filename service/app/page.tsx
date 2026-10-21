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
            <path d="m14 14-4 6h4l-1 4 5-7h-4l1-3Z" fill="#f6f4ef" />
          </svg>
          juiced
        </a>
        <nav aria-label="Main navigation">
          <a href="#how-it-works">How it works</a>
          <a href="https://github.com/stepandel/juiced">
            GitHub <span aria-hidden="true">↗</span>
          </a>
        </nav>
      </header>
      <main>
        <section className="hero" aria-labelledby="headline">
          <div>
            <div className="eyebrow mono">
              <span className="dot"></span> Your terminal. More room to build.
            </div>
            <h1 id="headline">
              Claude Code,
              <br />
              with more <em>juice.</em>
            </h1>
            <p className="intro">
              Run Claude Code in an isolated cloud workspace. Keep your terminal, your code, and
              your Claude account.
            </p>
            <div className="actions">
              <a className="button" href="https://github.com/stepandel/juiced">
                Explore the project <span aria-hidden="true">↗</span>
              </a>
              <a className="text-link" href="#how-it-works">
                Take a look <span aria-hidden="true">↓</span>
              </a>
            </div>
            <p className="note">Private preview · Public CLI release coming soon</p>
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
                <span className="prompt">~/your-project $</span> juiced claude
              </div>
              <div className="orange">✳ Claude Code</div>
              <div className="dim">Your project. Your Claude account.</div>
              <div className="answer">
                An isolated workspace,
                <br />a little extra breathing room.
              </div>
              <div>
                <span className="orange">❯</span> Let's build something.{' '}
                <span className="cursor" aria-hidden="true"></span>
              </div>
            </div>
            <div className="terminal-foot">
              <span>LOCAL TERMINAL</span>
              <span>☁ &nbsp; CLOUD WORKSPACE</span>
            </div>
          </div>
        </section>
        <div className="principle mono">
          <span>
            <b>↗</b> Runs on Cantelop
          </span>
          <span>
            <b>◇</b> Isolated per account
          </span>
          <span>
            <b>⌘</b> Built for your terminal
          </span>
        </div>
        <section className="features" id="how-it-works" aria-label="How Juiced works">
          <article>
            <span className="number mono">01 / STAY IN YOUR FLOW</span>
            <h2>A familiar place to start.</h2>
            <p>
              Open your project and use Claude Code from your terminal. Juiced connects your local
              workflow to a persistent cloud workspace.
            </p>
          </article>
          <article>
            <span className="number mono">02 / MAKE SOME ROOM</span>
            <h2>Give your work its own space.</h2>
            <p>
              Each account gets an isolated Cantelop App. Projects keep their own workspaces, and
              conversations keep their context.
            </p>
          </article>
          <article>
            <span className="number mono">03 / BRING IT HOME</span>
            <h2>Your changes, on your terms.</h2>
            <p>
              Review and approve transfers between your laptop and the cloud. Keep local work safe
              while bringing completed changes back.
            </p>
          </article>
        </section>
        <section className="preview" aria-label="Release availability">
          <div>
            <h2>A little more juice is on the way.</h2>
            <p>
              Juiced is in private preview. Follow the project for source builds and release
              updates.
            </p>
          </div>
          <a className="text-link" href="https://github.com/stepandel/juiced#readme">
            Read the guide <span aria-hidden="true">↗</span>
          </a>
        </section>
      </main>
      <footer>
        <span>
          juiced <span aria-hidden="true">/</span> A little more room to build.
        </span>
        <div className="footer-links">
          <a href="https://github.com/stepandel/juiced">Source</a>
          <a href="https://cantelop.com">
            Powered by Cantelop <span aria-hidden="true">↗</span>
          </a>
        </div>
      </footer>
    </div>
  );
}
