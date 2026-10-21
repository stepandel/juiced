import { PublicPage } from '../site-components';
import { guides } from '../../src/guides';
import { pageMetadata } from '../../src/site';

const description =
  'Learn how to run Claude Code in a Juiced cloud workspace, reconnect to sessions, and bring your code back locally.';
export const metadata = pageMetadata(
  'Juiced documentation',
  description,
  '/docs',
);

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
      <div className="guide-list">
        {guides.map((guide) => (
          <article key={guide.slug}>
            <h2>
              <a href={`/docs/${guide.slug}`}>{guide.title}</a>
            </h2>
            <p>{guide.description}</p>
          </article>
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
