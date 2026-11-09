import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "DOCUSTUDIO — Free story to 10–20 minute documentary",
  description:
    "Turn a story into a cinematic 10–20 minute documentary for free: screenplay, neural narration, illustrations and a procedural score, all rendered locally.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
