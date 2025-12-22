# [Your Project Title]

> **MLP (Minimum Lovable Prototype)** built with [Kiro](https://kiro.dev) CLI agentic capabilities

[Brief description of your project goes here. What problem does it solve? Who is it for?]

## Demo

[Add screenshots, GIFs, or a link to a live demo here]

---

## Tech Stack

- **React 19** - UI library with the latest features
- **Vite 7** - Next-gen build tool and dev server
- **TypeScript 5.9** - Type safety
- **Tailwind CSS 4** - Utility-first CSS with CSS-based configuration
- **shadcn/ui** - Accessible component library built on Radix UI
- **React Router 7** - Client-side routing
- **TanStack Query 5** - Data fetching and caching
- **React Hook Form + Zod 4** - Form handling and validation

## Getting Started

### Prerequisites

- Node.js >= 20.0.0
- npm or your preferred package manager

### Installation

```bash
# Clone the repository
git clone <your-repo-url>
cd <your-project-name>

# Install dependencies
npm install

# Start development server
npm run dev
```

The dev server runs at `http://localhost:8080` by default.

### Available Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start development server |
| `npm run build` | Build for production |
| `npm run preview` | Preview production build |
| `npm run lint` | Run ESLint |
| `npm run type-check` | Run TypeScript type checking |

## Project Structure

```
src/
├── components/
│   ├── ui/          # shadcn/ui components
│   └── ...          # Custom components
├── hooks/           # Custom React hooks
├── lib/             # Utility functions
├── pages/           # Page components
├── App.tsx          # Root component with routing
├── main.tsx         # Entry point
└── index.css        # Global styles and Tailwind v4 theme
```

## Adding Components

This project uses shadcn/ui. Add new components with:

```bash
npx shadcn@latest add button
npx shadcn@latest add card
```

## Configuration

- `vite.config.ts` - Vite configuration with Tailwind v4 plugin
- `tsconfig.json` - TypeScript configuration
- `components.json` - shadcn/ui configuration
- `eslint.config.js` - ESLint flat config

## License

MIT
