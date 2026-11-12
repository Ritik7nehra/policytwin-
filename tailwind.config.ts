import type { Config } from 'tailwindcss';

/**
 * "Financial Intelligence Control Room" tokens.
 * The fills/borders/icons use the brief's palette exactly. For TEXT, a few brand colours do not reach WCAG AA on their
 * tinted backgrounds (measured: muted 4.46:1 on canvas, pass 4.12:1 on its tint, amber 3.12:1, cyan 2.60:1), so each has an
 * `ink` variant (≥ 4.5:1 on every surface it is used on) — see docs/DESIGN_TOKENS.md.
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        canvas: '#F4F7FB',
        surface: { DEFAULT: '#FFFFFF', 2: '#EEF3F9' },
        navy: { DEFAULT: '#071A33', 2: '#0C2547', 3: '#14325E' },
        brand: { DEFAULT: '#1769E0', ink: '#1257B8', electric: '#3987F5', bg: '#EAF3FF' },
        twin: { DEFAULT: '#18AFCF', ink: '#09708A', bg: '#E6F7FB' },
        ink: { DEFAULT: '#0B1F38', mute: '#55677E' },
        line: { DEFAULT: '#DCE5EF', strong: '#C3D1E2' },
        pass: { DEFAULT: '#11875D', ink: '#0B6B4A', bg: '#E9F8F1' },
        review: { DEFAULT: '#C77A08', ink: '#8F5600', bg: '#FFF5DE' },
        block: { DEFAULT: '#C9363E', ink: '#A82A31', bg: '#FDECEE' },
      },
      fontFamily: {
        sans: ['"Inter Variable"', 'Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        display: ['"Space Grotesk Variable"', '"Space Grotesk"', '"Inter Variable"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono Variable"', '"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      borderRadius: { lg: '10px', xl: '14px', '2xl': '18px' },
      boxShadow: {
        card: '0 1px 2px rgba(7,26,51,.04), 0 4px 14px rgba(7,26,51,.05)',
        lift: '0 2px 4px rgba(7,26,51,.06), 0 12px 28px rgba(7,26,51,.10)',
        drawer: '-10px 0 36px rgba(7,26,51,.16)',
        ring: '0 0 0 3px rgba(23,105,224,.25)',
      },
      keyframes: {
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'rise-in': { from: { opacity: '0', transform: 'translateY(6px)' }, to: { opacity: '1', transform: 'none' } },
        'drawer-in': { from: { transform: 'translateX(24px)', opacity: '0' }, to: { transform: 'none', opacity: '1' } },
        'sheet-in': { from: { transform: 'translateY(16px)', opacity: '0' }, to: { transform: 'none', opacity: '1' } },
        'pulse-once': { '0%': { boxShadow: '0 0 0 0 rgba(201,54,62,.45)' }, '100%': { boxShadow: '0 0 0 18px rgba(201,54,62,0)' } },
        'flash-once': { '0%': { backgroundColor: 'rgba(24,175,207,.35)' }, '100%': { backgroundColor: 'rgba(24,175,207,0)' } },
        flow: { to: { strokeDashoffset: '-24' } },
        shimmer: { '100%': { transform: 'translateX(100%)' } },
        spin: { to: { transform: 'rotate(360deg)' } },
      },
      animation: {
        'fade-in': 'fade-in .2s ease-out both',
        'rise-in': 'rise-in .25s ease-out both',
        'drawer-in': 'drawer-in .22s cubic-bezier(.2,.8,.2,1) both',
        'sheet-in': 'sheet-in .22s cubic-bezier(.2,.8,.2,1) both',
        'pulse-once': 'pulse-once 1.2s ease-out 1',
        'flash-once': 'flash-once 1.1s ease-out 1',
        flow: 'flow 1s linear infinite',
      },
    },
  },
  plugins: [],
};

export default config;
