/** The public site stays available while account infrastructure is configured. */
export function landingPage() {
  return new Response(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Juiced — Claude Code, with more juice.</title>
  <meta name="description" content="Run Claude Code in an isolated cloud workspace. Keep your terminal, your code, and your Claude account.">
  <meta name="theme-color" content="#f6f4ef">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <style>
    :root{color-scheme:light;--paper:#f6f4ef;--ink:#29251f;--muted:#756e65;--line:#ded9ce;--orange:#ef673b}
    *{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
    a{color:inherit;text-underline-offset:4px}a:focus-visible{outline:3px solid var(--orange);outline-offset:6px}::selection{background:#ffd2b9}
    .wrap{width:min(1120px,calc(100% - 64px));margin:auto}.mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
    header{height:102px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line)}
    .brand{display:inline-flex;gap:10px;align-items:center;text-decoration:none;font-size:28px;font-weight:800;letter-spacing:-1.4px}.mark{width:26px;height:30px;color:var(--orange)}
    nav{display:flex;gap:30px;font-size:14px}nav a{text-decoration:none}nav a:hover{text-decoration:underline}
    .hero{display:grid;grid-template-columns:1fr 1fr;gap:62px;align-items:center;padding:100px 0 110px}.eyebrow{display:flex;gap:9px;align-items:center;font-size:12px;color:var(--muted);letter-spacing:.06em;text-transform:uppercase}.dot{width:7px;height:7px;background:var(--orange);border-radius:50%;display:inline-block}
    h1{font-size:clamp(48px,5.4vw,70px);line-height:1.06;font-weight:650;letter-spacing:-3.8px;margin:25px 0}h1 em{color:var(--orange);font-style:normal}
    .intro{font-size:18px;color:var(--muted);max-width:430px;line-height:1.7}.actions{display:flex;gap:22px;align-items:center;margin:30px 0 17px}.button{display:inline-flex;align-items:center;gap:18px;background:var(--ink);color:var(--paper);padding:12px 20px;border-radius:5px;text-decoration:none;font-size:14px;font-weight:550}.button:hover{background:#4b4238}.text-link{font-size:14px;text-decoration:none}.text-link:hover{text-decoration:underline}.note{font-size:12px;color:var(--muted)}
    .terminal{border:1px solid #403a32;border-radius:10px;background:#24221e;color:#eae5dc;box-shadow:0 24px 48px #33291b16;transform:rotate(1deg);overflow:hidden}.terminal-top{height:45px;display:flex;align-items:center;gap:6px;border-bottom:1px solid #3b372f;padding:0 17px}.light{width:7px;height:7px;border-radius:50%;background:#5f584d}.terminal-title{margin:auto;color:#a69d90;font-size:11px;transform:translateX(-16px)}.terminal-body{padding:29px 26px 32px;font-size:13px;line-height:1.9;min-height:310px}.command{margin-bottom:25px}.prompt{color:#bcad97}.orange{color:#ff996e}.dim{color:#a69d90}.answer{margin:20px 0 26px;padding-left:14px;border-left:2px solid #71614c}.cursor{display:inline-block;height:15px;width:7px;background:#f4a177;vertical-align:-3px}.terminal-foot{border-top:1px solid #3b372f;padding:9px 18px;color:#a69d90;font-size:10px;display:flex;justify-content:space-between}
    .principle{border-top:1px solid var(--line);border-bottom:1px solid var(--line);display:flex;justify-content:space-between;gap:30px;padding:23px 0;font-size:13px;color:var(--muted)}.principle span{display:flex;gap:10px;align-items:center}.principle b{color:var(--orange);font-weight:500}
    .features{padding:68px 0 78px;display:grid;grid-template-columns:repeat(3,1fr);gap:50px}.number{color:var(--orange);font-size:12px}h2{font-size:21px;letter-spacing:-.6px;font-weight:600;margin:15px 0 12px}.features p{color:var(--muted);font-size:14px;line-height:1.8;margin:0}
    .preview{border:1px solid var(--line);border-radius:8px;padding:30px 34px;display:flex;gap:30px;justify-content:space-between;align-items:center;background:#f0ece3;margin-bottom:78px}.preview h2{margin:0 0 5px}.preview p{margin:0;color:var(--muted);font-size:14px}.preview a{flex-shrink:0}
    footer{border-top:1px solid var(--line);padding:25px 0 36px;display:flex;align-items:center;justify-content:space-between;gap:20px;font-size:12px;color:var(--muted)}footer a{text-decoration:none}footer a:hover{text-decoration:underline}.footer-links{display:flex;gap:25px}
    @media(max-width:900px){.hero{gap:32px;padding:72px 0 80px}h1{font-size:52px;letter-spacing:-2.8px}.terminal-body{padding:24px 20px;font-size:11px}.features{gap:25px}.actions{gap:16px}.button{padding:11px 16px}}
    @media(max-width:680px){.wrap{width:calc(100% - 40px)}header{height:80px}nav{gap:20px;font-size:13px}.hero{grid-template-columns:1fr;gap:40px;padding:52px 0 56px}h1{font-size:56px;letter-spacing:-3px}.intro{font-size:17px}.terminal{transform:none}.terminal-body{font-size:13px;min-height:285px}.principle{flex-wrap:wrap;gap:13px;padding:20px 0}.features{grid-template-columns:1fr;gap:32px;padding:44px 0}.features h2{margin-top:8px}.preview{align-items:flex-start;flex-direction:column;gap:20px;padding:25px;margin-bottom:46px}footer{align-items:flex-start;flex-direction:column;gap:12px}}
    @media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <a href="/" class="brand" aria-label="Juiced home"><svg class="mark" viewBox="0 0 26 30" fill="none" aria-hidden="true"><path d="M5 10h16l-2 16H7L5 10Z" fill="currentColor"/><path d="m14 3-2 7M5 7h16" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><path d="m14 14-4 6h4l-1 4 5-7h-4l1-3Z" fill="#f6f4ef"/></svg>juiced</a>
      <nav aria-label="Main navigation"><a href="#how-it-works">How it works</a><a href="https://github.com/stepandel/juiced">GitHub <span aria-hidden="true">↗</span></a></nav>
    </header>
    <main>
      <section class="hero" aria-labelledby="headline">
        <div>
          <div class="eyebrow mono"><span class="dot"></span> Your terminal. More room to build.</div>
          <h1 id="headline">Claude Code,<br>with more <em>juice.</em></h1>
          <p class="intro">Run Claude Code in an isolated cloud workspace. Keep your terminal, your code, and your Claude account.</p>
          <div class="actions"><a class="button" href="https://github.com/stepandel/juiced">Explore the project <span aria-hidden="true">↗</span></a><a class="text-link" href="#how-it-works">Take a look <span aria-hidden="true">↓</span></a></div>
          <p class="note">Private preview · Public CLI release coming soon</p>
        </div>
        <div class="terminal mono" aria-label="Example of using Juiced from a terminal">
          <div class="terminal-top"><i class="light"></i><i class="light"></i><i class="light"></i><span class="terminal-title">your-project — juiced</span></div>
          <div class="terminal-body">
            <div class="command"><span class="prompt">~/your-project $</span> juiced claude</div>
            <div class="orange">✳ Claude Code</div>
            <div class="dim">Your project. Your Claude account.</div>
            <div class="answer">An isolated workspace,<br>a little extra breathing room.</div>
            <div><span class="orange">❯</span> Let's build something. <span class="cursor" aria-hidden="true"></span></div>
          </div>
          <div class="terminal-foot"><span>LOCAL TERMINAL</span><span>☁ &nbsp; CLOUD WORKSPACE</span></div>
        </div>
      </section>
      <div class="principle mono"><span><b>↗</b> Runs on Cantelop</span><span><b>◇</b> Isolated per account</span><span><b>⌘</b> Built for your terminal</span></div>
      <section class="features" id="how-it-works" aria-label="How Juiced works">
        <article><span class="number mono">01 / STAY IN YOUR FLOW</span><h2>A familiar place to start.</h2><p>Open your project and use Claude Code from your terminal. Juiced connects your local workflow to a persistent cloud workspace.</p></article>
        <article><span class="number mono">02 / MAKE SOME ROOM</span><h2>Give your work its own space.</h2><p>Each account gets an isolated Cantelop App. Projects keep their own workspaces, and conversations keep their context.</p></article>
        <article><span class="number mono">03 / BRING IT HOME</span><h2>Your changes, on your terms.</h2><p>Review and approve transfers between your laptop and the cloud. Keep local work safe while bringing completed changes back.</p></article>
      </section>
      <section class="preview" aria-label="Release availability"><div><h2>A little more juice is on the way.</h2><p>Juiced is in private preview. Follow the project for source builds and release updates.</p></div><a class="text-link" href="https://github.com/stepandel/juiced#readme">Read the guide <span aria-hidden="true">↗</span></a></section>
    </main>
    <footer><span>juiced <span aria-hidden="true">/</span> A little more room to build.</span><div class="footer-links"><a href="https://github.com/stepandel/juiced">Source</a><a href="https://cantelop.com">Powered by Cantelop <span aria-hidden="true">↗</span></a></div></footer>
  </div>
</body>
</html>`, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=0, s-maxage=3600',
      'Content-Security-Policy': "default-src 'self'; script-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
