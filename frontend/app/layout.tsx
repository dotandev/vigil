import type { Metadata, Viewport } from "next";
import { Fraunces, Inter, JetBrains_Mono } from "next/font/google";
import { Providers } from "@/components/providers";
import { Footer, Nav } from "@/components/Nav";
import "./globals.css";

const serif = Fraunces({ subsets: ["latin"], weight: ["400", "600"], style: ["normal", "italic"], variable: "--font-serif" });
const sans = Inter({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-sans" });
const mono = JetBrains_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-mono" });

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "https://dotandev.github.io"),
  title: { default: "Vigil · keyless crypto inheritance on NEAR", template: "%s · Vigil" },
  description: "A watchman that is paid by what it guards, and dies when you do. No seed phrase, no guardians.",
  openGraph: {
    title: "Vigil",
    description: "A watchman that is paid by what it guards, and dies when you do.",
    type: "website",
  },
  twitter: { card: "summary_large_image" },
};

export const viewport: Viewport = { themeColor: "#0b0d10" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${serif.variable} ${sans.variable} ${mono.variable}`}>
      <body>
        <Providers>
          <a className="skip" href="#content">
            Skip to content
          </a>
          <Nav />
          <div id="content" className="content">
            {children}
          </div>
          <Footer />
        </Providers>
      </body>
    </html>
  );
}
