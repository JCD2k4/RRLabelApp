"use client";

export default function Modal({ children }: { children: React.ReactNode }) {
  return (
    <div className="backdrop">
      <div className="card">{children}</div>
    </div>
  );
}
