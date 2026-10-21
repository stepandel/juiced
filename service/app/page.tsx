import { InstallCommand } from './install-command';
import { SiteHeader, SiteFooter } from './site-components';
import { guides } from '../src/guides';
import { pageMetadata, site } from '../src/site';

// Placeholder until the install script ships.
const install = 'curl -fsSL https://juiced.codes/install.sh | sh';

export const metadata = pageMetadata(
  { absolute: site.title },
  site.description,
  '/',
);

export default function Home() {
  return (
    <div className="wrap">
      <SiteHeader />
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
        <section className="hero" aria-labelledby="headline">
          <div>
            <h1 id="headline">
              Claude Code,
              <br />
              <em>always on.</em>
            </h1>
            <p className="intro">
              Juiced runs Claude Code in a private cloud workspace that you
              drive from your terminal. Close your laptop. Claude keeps working.
            </p>
            <InstallCommand command={install} />
            <p className="next mono">
              then run <code>juiced claude</code> in your project
            </p>
          </div>
          <div
            className="terminal mono"
            aria-label="Example of using Juiced from a terminal"
          >
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
                <span className="green">❯</span> add a settings page with a
                theme toggle
              </div>
              <div>
                <span className="green">●</span> Read{' '}
                <span className="dim">3 files</span>
              </div>
              <div>
                <span className="green">●</span> Write{' '}
                <span className="dim">app/settings/page.tsx</span>
              </div>
              <div className="turn">
                <span className="green">❯</span> /detach
              </div>
              <div className="dim indent">
                ⎿ Detached. Claude is still working.
              </div>
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
              Your first <code>juiced claude</code> in a repo copies it to a
              private cloud workspace. Your code, Claude login and conversations
              stay there between runs.
            </p>
          </article>
          <article>
            <span className="number mono">02</span>
            <h3>A sandbox for every session</h3>
            <p>
              Claude Code runs in an isolated sandbox attached to that
              workspace. You drive it from your terminal, and it keeps going
              when you disconnect.
            </p>
          </article>
          <article>
            <span className="number mono">03</span>
            <h3>Shut down when idle</h3>
            <p>
              Once Claude is done, the sandbox shuts down. Run{' '}
              <code>juiced claude</code> again to pick up the same conversation.
            </p>
          </article>
          <article>
            <span className="number mono">04</span>
            <h3>Changes come back on your terms</h3>
            <p>
              Pull Claude's commits into your local repo when you're ready.
              Nothing changes on your laptop until you approve it.
            </p>
          </article>
        </section>
        <section className="learn-more" aria-labelledby="learn-more">
          <h2 id="learn-more">Run Claude Code in the cloud</h2>
          <p>
            Learn how to start a workspace, leave Claude running, and bring your
            changes home.
          </p>
          <p>Requires Node.js 22 or later and your own Claude Code access.</p>
          <nav className="guide-links" aria-label="Learn about Juiced">
            {guides.map(({ slug, title }) => (
              <a key={slug} href={`/docs/${slug}`}>
                {title}
              </a>
            ))}
          </nav>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
