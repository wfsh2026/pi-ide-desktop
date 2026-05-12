import assert from "node:assert/strict";
import { buildSessionTimeline, splitMarkdownSections, stripAnsiText } from "./sessionTimelineModel.js";

assert.equal(stripAnsiText("\u001b[31m错误\u001b[0m"), "错误");

assert.deepEqual(buildSessionTimeline(null), []);

const turnTimeline = buildSessionTimeline({
  id: "s1",
  turns: [{
    id: "t1",
    status: "running",
    user_text: "修复构建",
    final_prompt: "修复构建",
    attachments: [{ name: "package.json", path: "package.json" }],
    output: "\u001b[32m完成\u001b[0m"
  }]
});

assert.equal(turnTimeline.length, 1);
assert.equal(turnTimeline[0].items[0].type, "user_message");
assert.equal(turnTimeline[0].items[0].text, "修复构建");
assert.equal(turnTimeline[0].items[1].text, "完成");
assert.equal(turnTimeline[0].items[0].attachments[0].name, "package.json");

const fallbackTimeline = buildSessionTimeline({
  id: "s2",
  first_prompt: "解释代码",
  output: "这是结果"
});

assert.equal(fallbackTimeline.length, 1);
assert.equal(fallbackTimeline[0].items[0].text, "解释代码");
assert.equal(fallbackTimeline[0].items[1].text, "这是结果");

const itemTimeline = buildSessionTimeline({
  id: "s3",
  turns: [{
    id: "t3",
    items: [
      { type: "progress", title: "运行测试", status: "completed" },
      { type: "thinking", text: "\u001b[33m先理解需求\u001b[0m", status: "completed" },
      { type: "file_output", files: [{ name: "App.jsx", path: "src/App.jsx" }] }
    ]
  }]
});

assert.equal(itemTimeline[0].items[0].type, "progress");
assert.equal(itemTimeline[0].items[1].type, "thinking");
assert.equal(itemTimeline[0].items[1].text, "先理解需求");
assert.equal(itemTimeline[0].items[2].files[0].path, "src/App.jsx");

const sections = splitMarkdownSections("说明\n```js\nconsole.log(1)\n```\n完成");
assert.equal(sections.length, 3);
assert.equal(sections[1].type, "code");
assert.equal(sections[1].language, "js");

console.log("session timeline model ok");
