import type { Config } from 'tailwindcss';
import { colors } from '@tankbet/shared/theme';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        primary: {
          DEFAULT: colors.primary,
          hover:   colors.primaryHover,
          muted:   colors.primaryMuted,
          bg:      colors.primaryBg,
        },
        game: {
          bg:      colors.background,
          surface: colors.surface,
          raised:  colors.surfaceRaised,
          border:  colors.border,
        },
        win:     colors.win,
        loss:    colors.loss,
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      fontVariantNumeric: {
        tabular: 'tabular-nums',
      },
    },
  },
  plugins: [],
} satisfies Config;
