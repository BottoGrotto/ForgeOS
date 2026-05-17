import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        forge: {
          bg: "#0b0d10",
          panel: "#14181d",
          line: "#2a323b",
          text: "#edf2f7",
          muted: "#9aa6b2",
          cyan: "#2dd4bf",
          blue: "#60a5fa",
          amber: "#f59e0b",
          green: "#34d399",
          red: "#fb7185"
        }
      },
      boxShadow: {
        command: "0 18px 60px rgba(0, 0, 0, 0.35)"
      }
    }
  },
  plugins: []
};

export default config;
