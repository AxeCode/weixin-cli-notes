import matter from "gray-matter";
import remarkFrontmatter from "remark-frontmatter";

const Frontmatter = () => ({
  name: "Frontmatter",
  markdownPlugins() {
    return [
      [remarkFrontmatter, ["yaml", "toml"]],
      () => (_, file) => {
        const parsed = matter(String(file.value));
        const data = parsed.data ?? {};
        data.title = data.title?.toString() || file.stem || "Untitled";
        if (typeof data.tags === "string") data.tags = [data.tags];
        if (!Array.isArray(data.tags)) data.tags = [];
        file.data.frontmatter = data;
      },
    ];
  },
});

export { Frontmatter };
