import { PublicPage } from '../site-components';
import { guides } from '../../src/guides';
import { pageMetadata } from '../../src/site';

const description =
  'Learn how to run Claude Code in a Juiced cloud workspace, reconnect to sessions, and bring your code back locally.';
export const metadata = pageMetadata('Documentation', description, '/docs');

export default function Docs() {
  return (
    <PublicPage
      title="Claude Code in the cloud, from your terminal."
      intro={description}
    >
      <p>
        Juiced keeps your project, Claude login, and conversations in a
        persistent cloud workspace. Start with setup, then learn how sessions
        and code transfers work.
      </p>
      <div className="guide-grid docs-index">
        {guides.map((guide) => (
          <a key={guide.slug} href={`/docs/${guide.slug}`} className="guide-card">
            <span className="path mono">docs/{guide.slug}</span>
            <h2>{guide.title}</h2>
            <p>{guide.description}</p>
            <span className="go mono" aria-hidden="true">
              read →
            </span>
          </a>
        ))}
      </div>
      <p>
        See <a href="/pricing">pricing and availability</a> for managed access,
        or explore the{' '}
        <a href="https://github.com/stepandel/juiced">source on GitHub</a>.
      </p>
    </PublicPage>
  );
}
