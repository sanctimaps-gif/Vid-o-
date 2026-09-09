const COLORS = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
};

const useColor = process.stdout.isTTY === true && !process.env.NO_COLOR;

function paint(color: keyof typeof COLORS, text: string): string {
  return useColor ? `${COLORS[color]}${text}${COLORS.reset}` : text;
}

export const log = {
  step(message: string): void {
    console.log(`${paint("cyan", "▸")} ${message}`);
  },
  info(message: string): void {
    console.log(`  ${paint("dim", message)}`);
  },
  success(message: string): void {
    console.log(`${paint("green", "✓")} ${message}`);
  },
  warn(message: string): void {
    console.warn(`${paint("yellow", "!")} ${message}`);
  },
  error(message: string): void {
    console.error(`${paint("red", "✗")} ${message}`);
  },
};
