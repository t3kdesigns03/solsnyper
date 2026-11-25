/** @type {import('next').NextConfig} */
// Static export: Cloudflare Pages serves ./out as plain files and the browser
// polls the Worker API directly (NEXT_PUBLIC_API_URL). No server runtime needed.
const nextConfig = {
  output: "export",
  images: { unoptimized: true },
};
export default nextConfig;
