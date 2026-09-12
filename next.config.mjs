/** @type {import('next').NextConfig} */
const nextConfig = {
  // everything runs in the browser; no server features are used
  reactStrictMode: true,
  // dev serves on localhost, but people reach it by IP too (WSL, another machine
  // on the LAN); without this Next blocks the HMR socket and the page never
  // becomes interactive
  allowedDevOrigins: ["localhost", "127.0.0.1", "*.local"],
  // the optional live-learning trainer (python assist.py); proxied so the browser
  // only ever talks to this origin, however it reached the app
  async rewrites() {
    const target = process.env.ASSIST_URL ?? "http://127.0.0.1:8778";
    return [{ source: "/assist/:path*", destination: `${target}/:path*` }];
  },
};
export default nextConfig;
