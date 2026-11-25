import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SolSnyper (paper)",
  description: "Simulated Solana meme-coin sniper dashboard. Paper trading only.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
