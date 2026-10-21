import { PublicPage } from '../site-components';
import { pageMetadata } from '../../src/site';

const description =
  'Juiced is free: every feature and the compute your workspaces use. Claude Code access is separate.';
export const metadata = pageMetadata('Pricing', description, '/pricing');

export default function Pricing() {
  return (
    <PublicPage title="Pricing" eyebrow={null}>
      <div className="pricing-grid">
        <section className="pricing-card" aria-labelledby="free-plan">
          <h2 id="free-plan">Free</h2>
          <p className="price">$0</p>
          <p>Every feature and the compute your workspaces use.</p>
        </section>
      </div>
      <p className="pricing-details">
        Juiced accounts are free while we learn how people use them. Claude
        Code access is separate.
      </p>
      <p>
        <a href="/docs/getting-started">Get started</a>
      </p>
    </PublicPage>
  );
}
