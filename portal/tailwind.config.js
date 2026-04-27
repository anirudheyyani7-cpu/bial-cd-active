/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        primary: {
          DEFAULT: '#00818A',
          50: '#E0F5F6',
          100: '#B3E6E9',
          200: '#80D5DA',
          300: '#4DC4CC',
          400: '#26B7C0',
          500: '#00818A',
          600: '#006E76',
          700: '#005A61',
          800: '#00474D',
          900: '#1A2B34',
        },
        secondary: {
          DEFAULT: '#D9A036',
          50: '#FDF5E6',
          100: '#FAE7BF',
          200: '#F7D896',
          300: '#F3C96C',
          400: '#F1BD4E',
          500: '#D9A036',
          600: '#C08A2E',
          700: '#A67326',
          800: '#8C5D1E',
          900: '#6B430F',
        },
        tertiary: '#1A2B34',
        neutral: '#64748B',
        bial: {
          bg: '#F0F4F8',
          surface: '#FFFFFF',
          border: '#E2E8F0',
        },
      },
      fontFamily: {
        manrope: ['Manrope', 'sans-serif'],
        worksans: ['"Work Sans"', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
