import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Exponent-style dark neutral palette
        eclipse: {
          950: '#0a0a0a',
          900: '#111111',
          800: '#1a1a1a',
          700: '#252525',
          600: '#333333',
        },
        solar: {
          500: '#6b66ff',
          400: '#8c8aff',
          300: '#b5b3ff',
        },
        flare: {
          500: '#ffb74d',
          400: '#ffd08a',
          300: '#ffe4b5',
        },
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'Inter', 'system-ui', 'sans-serif'],
        mono: ['SFMono-Regular', 'Menlo', 'Monaco', 'monospace'],
      },
    },
  },
  plugins: [],
};
export default config;
