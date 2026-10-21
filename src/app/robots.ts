import type { MetadataRoute } from "next";
import { WEBSITE_DOMAIN } from "@/lib/site";

// Served at /robots.txt. Allows crawling of the public marketing and
// legal pages while keeping the authenticated app and API out of search
// indexes. Points crawlers at the sitemap.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/", "/privacy-policy", "/terms-and-conditions"],
        disallow: [
          "/dashboard",
          "/inbox",
          "/contacts",
          "/pipelines",
          "/broadcasts",
          "/automations",
          "/flows",
          "/agents",
          "/templates",
          "/quick-replies",
          "/chat-assignment",
          "/lead-assignment",
          "/data-export",
          "/notifications",
          "/settings",
          "/login",
          "/signup",
          "/forgot-password",
          "/join",
          "/api/",
        ],
      },
    ],
    sitemap: `${WEBSITE_DOMAIN}/sitemap.xml`,
    host: WEBSITE_DOMAIN,
  };
}
