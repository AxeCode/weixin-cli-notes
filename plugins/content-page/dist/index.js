import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { Fragment, jsx, jsxs } from "preact/jsx-runtime";
import { h } from "preact";

function childrenToString(children) {
  if (typeof children === "string") return children;
  if (Array.isArray(children)) return children.map(childrenToString).join("");
  return String(children ?? "");
}

const customComponents = {
  table: (props) => h("div", { class: "table-container" }, h("table", props)),
  style: ({ children, ...rest }) =>
    h("style", { ...rest, dangerouslySetInnerHTML: { __html: childrenToString(children) } }),
  script: ({ children, ...rest }) =>
    h("script", { ...rest, dangerouslySetInnerHTML: { __html: childrenToString(children) } }),
};

function htmlToJsx(tree) {
  return toJsxRuntime(tree, {
    Fragment,
    jsx,
    jsxs,
    elementAttributeNameCase: "html",
    components: customComponents,
  });
}

const ContentBody = () => ({ fileData, tree }) => {
  const content = htmlToJsx(tree);
  const classes = fileData?.frontmatter?.cssclasses ?? [];
  return h("article", { class: ["popover-hint", ...classes].join(" ") }, content);
};

const contentMatcher = ({ slug }) => !slug.endsWith("/index") && !slug.startsWith("tags/");

const ContentPage = () => ({
  name: "ContentPage",
  priority: 0,
  match: contentMatcher,
  layout: "content",
  body: ContentBody,
});

export { ContentBody, ContentPage };
