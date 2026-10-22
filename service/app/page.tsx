import { InstallCommand } from './install-command';
import { SiteHeader, SiteFooter } from './site-components';
import { guides } from '../src/guides';
import { pageMetadata, site } from '../src/site';

const install = 'curl -fsSL https://juiced.codes/install.sh | sh';

function ArrowUpRight() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M7 17 17 7M8 7h9v9" />
    </svg>
  );
}

export const metadata = pageMetadata(
  { absolute: site.title },
  site.description,
  '/',
);

export default function Home() {
  return (
    <>
      <div className="wrap">
        <SiteHeader />
      </div>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            '@context': 'https://schema.org',
            '@graph': [
              {
                '@type': 'WebSite',
                '@id': `${site.url}/#website`,
                name: site.name,
                url: site.url,
                description: site.description,
              },
              {
                '@type': 'SoftwareApplication',
                '@id': `${site.url}/#software`,
                name: site.name,
                url: site.url,
                description: site.description,
                applicationCategory: 'DeveloperApplication',
                runtimePlatform: 'Node.js 22+',
                softwareRequirements: 'Your own Claude Code login',
                sameAs: site.github,
                featureList: [
                  'Persistent cloud workspaces',
                  'Terminal interface',
                  'Detach and reconnect',
                  'Explicit Git transfers',
                ],
              },
            ],
          }).replaceAll('<', '\\u003c'),
        }}
      />
      <main>
        <div className="wrap">
          <section className="hero" aria-labelledby="headline">
            <div>
              <p className="label">
                <i className="dot"></i>Cloud workspaces for Claude Code
              </p>
              <h1 id="headline">
                Claude Code,
                <br />
                with more <em>juice.</em>
              </h1>
              <p className="intro">
                Juiced runs Claude Code in a private cloud workspace that you
                drive from your terminal.{' '}
                <strong>Close your laptop. Claude keeps working.</strong>
              </p>
              <InstallCommand command={install}>
                <code>
                  <span className="prompt" aria-hidden="true">
                    ${' '}
                  </span>
                  juiced claude{' '}
                  <span className="cmt"># then run in your project</span>
                </code>
              </InstallCommand>
              <p className="hero-meta mono">
                <span>
                  <i className="dot"></i>Node.js 22+
                </span>
                <span>Your own Claude Code login</span>
              </p>
            </div>
            <figure
              className="terminal mono"
              aria-label="Example of using Juiced from a terminal"
            >
              <div className="terminal-top">
                <span className="lights" aria-hidden="true">
                  <i></i>
                  <i></i>
                  <i></i>
                </span>
                <span className="terminal-tab">
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="m4 17 6-5-6-5M12 19h8" />
                  </svg>
                  your-project — juiced
                </span>
              </div>
              <div className="terminal-body">
                <div>
                  <span className="dim">~/your-project $</span> juiced claude
                </div>
                <div className="turn">
                  <span className="green" aria-hidden="true">
                    ❯
                  </span>{' '}
                  add a settings page with a theme toggle
                </div>
                <div>
                  <span className="green" aria-hidden="true">
                    ●
                  </span>{' '}
                  Read <span className="dim">3 files</span>
                </div>
                <div>
                  <span className="green" aria-hidden="true">
                    ●
                  </span>{' '}
                  Write <span className="dim">app/settings/page.tsx</span>
                </div>
                <div className="turn">
                  <span className="green" aria-hidden="true">
                    ❯
                  </span>{' '}
                  /detach
                </div>
                <div className="dim indent">
                  <span aria-hidden="true">⎿ </span>Detached. Claude is still
                  working.
                </div>
                <div className="turn">
                  <span className="dim">~/your-project $</span>{' '}
                  <span className="cursor" aria-hidden="true"></span>
                </div>
              </div>
              <div className="terminal-foot">
                <span>
                  <i className="dot"></i>
                  <b>cloud workspace</b>
                </span>
                <span className="session">
                  session <em>detached</em> · claude <em>running</em>
                </span>
              </div>
            </figure>
          </section>
          <section className="band" aria-labelledby="how">
            <div className="section-head">
              <div>
                <p className="label">
                  <span className="hash">//</span>How it works
                </p>
                <h2 id="how">Four steps, no server to babysit.</h2>
              </div>
              <p>
                Your code, Claude login and conversations live in a private
                cloud workspace. Your terminal is the remote control.
              </p>
            </div>
            <ol className="steps">
              <li>
                <span className="number mono">01</span>
                <h3>Start Claude in the cloud</h3>
                <p>
                  Juiced copies your repo to a private workspace and runs Claude
                  Code there in its own sandbox.
                </p>
                <div className="cmd mono">
                  <span className="prompt">$ </span>juiced claude
                </div>
              </li>
              <li>
                <span className="number mono">02</span>
                <h3>Close your laptop</h3>
                <p>
                  Detach or close the terminal. Claude keeps working without
                  you.
                </p>
                <div className="cmd mono">
                  <span className="prompt">❯ </span>/detach
                </div>
              </li>
              <li>
                <span className="number mono">03</span>
                <h3>Pick up where you left off</h3>
                <p>
                  Run it again to reconnect to the same conversation. Idle
                  compute shuts down, but your files stay.
                </p>
                <div className="cmd mono">
                  <span className="prompt">$ </span>juiced claude
                </div>
              </li>
              <li>
                <span className="number mono">04</span>
                <h3>Bring the changes home</h3>
                <p>
                  Apply Claude's commits to your local branch. Nothing on your
                  laptop changes until you do.
                </p>
                <div className="cmd mono">
                  <span className="prompt">$ </span>juiced claude fast-forward
                </div>
              </li>
            </ol>
          </section>
          <section className="band" aria-labelledby="learn-more">
            <div className="section-head">
              <div>
                <p className="label">
                  <span className="hash">//</span>Documentation
                </p>
                <h2 id="learn-more">Run Claude Code in the cloud</h2>
              </div>
              <p>
                Learn how to start a workspace, leave Claude running, and bring
                your changes home.
              </p>
            </div>
            <div className="guide-grid">
              {guides.map(({ slug, title, description }) => (
                <a key={slug} href={`/docs/${slug}`} className="guide-card">
                  <span className="path mono">
                    docs/{slug}
                    <ArrowUpRight />
                  </span>
                  <h3>{title}</h3>
                  <p>{description}</p>
                </a>
              ))}
              <a href="/docs" className="guide-card all">
                <div>
                  <span className="path mono">docs/</span>
                  <h3>All documentation</h3>
                  <p>Every guide in one place, from setup to Git transfers.</p>
                </div>
                <span className="go mono" aria-hidden="true">
                  Browse docs →
                </span>
              </a>
            </div>
          </section>
        </div>
        <section className="cta" aria-labelledby="cta">
          <div className="wrap">
            <div className="cta-inner">
              <p className="label">
                <span className="hash">//</span>Install
              </p>
              <h2 id="cta">
                Close your laptop.
                <br />
                <em>Claude keeps working.</em>
              </h2>
              <InstallCommand command={install} />
              <p className="mono">
                Requires Node.js 22+ and your own Claude Code access.
              </p>
            </div>
          </div>
        </section>
      </main>
      <div className="wrap">
        <SiteFooter />
      </div>
    </>
  );
}
