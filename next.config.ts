// File: next.config.mjs // [!code focus]

/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: { // [!code ++] // [!code focus]
    serverComponentsExternalPackages: ['grammy'], // [!code ++] // [!code focus]
  }, // [!code ++] // [!code focus]
}

export default nextConfig