/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      // Design plan: a quant research instrument, not a consumer dashboard --
      // dense, disciplined, one saturated accent reserved for the single
      // decision signal (the ORT score), everything else desaturated. Avoids
      // the three generic-AI defaults (cream+terracotta+serif, near-black+neon,
      // broadsheet hairlines) by grounding in BrokerForce's own stated
      // philosophy: cut noise down to the one number that matters.
      colors: {
        bg: {
          deep: "#0E1614", // deep teal-black, not pure black -- a liquidity-adjacent hue
          panel: "#15201D",
        },
        ink: {
          DEFAULT: "#E8EDE9", // warm off-white, slight green tint to match the bg family
          muted: "#8FA39B", // muted teal-gray for labels/secondary text
        },
        signal: "#E8A33D", // warm amber -- reserved ONLY for the ORT score / decision signal
        // Directional/semantic pair, desaturated to sit inside the teal-black
        // family rather than shout. The ONE sanctioned exception to the
        // "monochrome + single amber signal" rule: score movement is
        // read-at-a-glance finance data where green-up/red-down is a genuine
        // convention, not decoration. Introduced with 007 Watchlists' change
        // indicator; use only for gain/loss direction, never as a second accent.
        pos: "#5FA97C", // muted green -- score up / gain
        neg: "#C96A5B", // muted rust -- score down / loss
        line: "#2A3A35", // hairline dividers, subtle not stark
      },
      fontFamily: {
        display: ["Space Grotesk", "sans-serif"], // panel titles, structure -- used with restraint
        body: ["IBM Plex Sans", "sans-serif"], // labels, copy
        mono: ["IBM Plex Mono", "monospace"], // every actual number -- precision signaled by face, not just value
      },
    },
  },
  plugins: [],
};
