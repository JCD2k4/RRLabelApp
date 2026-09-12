import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Folkistan — annotator",
  description: "Box and mask annotation for robotics computer vision, exported straight to PyTorch.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
