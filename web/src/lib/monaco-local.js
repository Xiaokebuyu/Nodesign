/**
 * lib/monaco-local.js — Monaco 走本地打包，不去 CDN（2026-09-08 站主定）。
 *
 * `@monaco-editor/react` 默认从 jsdelivr 拉 monaco 本体，桌面版离线时代码阅读器
 * 就是一块白。这里把 npm 里的 monaco 喂给它的 loader，语言只挑仓库里常见的那些
 * （每种是一份 Monarch 分词表，几 KB 到几十 KB），不整包带 —— 整包 5MB+。
 *
 * ⚠️ 只在**用到编辑器的懒加载组件**里 import 这个文件（RepoWindow / CodeCanvas），
 *    别从主包引：它把 monaco 核心（~1MB）拖进来，主包不该背这个。
 */
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import { loader } from '@monaco-editor/react';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';

import 'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution';
import 'monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution';
import 'monaco-editor/esm/vs/basic-languages/html/html.contribution';
import 'monaco-editor/esm/vs/basic-languages/css/css.contribution';
import 'monaco-editor/esm/vs/basic-languages/scss/scss.contribution';
import 'monaco-editor/esm/vs/basic-languages/less/less.contribution';
import 'monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution';
import 'monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution';
import 'monaco-editor/esm/vs/basic-languages/ini/ini.contribution';
import 'monaco-editor/esm/vs/basic-languages/xml/xml.contribution';
import 'monaco-editor/esm/vs/basic-languages/sql/sql.contribution';
import 'monaco-editor/esm/vs/basic-languages/shell/shell.contribution';
import 'monaco-editor/esm/vs/basic-languages/dockerfile/dockerfile.contribution';
import 'monaco-editor/esm/vs/basic-languages/python/python.contribution';
import 'monaco-editor/esm/vs/basic-languages/go/go.contribution';
import 'monaco-editor/esm/vs/basic-languages/rust/rust.contribution';
import 'monaco-editor/esm/vs/basic-languages/java/java.contribution';
import 'monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution';
import 'monaco-editor/esm/vs/basic-languages/csharp/csharp.contribution';
import 'monaco-editor/esm/vs/basic-languages/ruby/ruby.contribution';
import 'monaco-editor/esm/vs/basic-languages/php/php.contribution';
import 'monaco-editor/esm/vs/basic-languages/swift/swift.contribution';
import 'monaco-editor/esm/vs/basic-languages/kotlin/kotlin.contribution';
import 'monaco-editor/esm/vs/basic-languages/dart/dart.contribution';
import 'monaco-editor/esm/vs/basic-languages/lua/lua.contribution';
import 'monaco-editor/esm/vs/basic-languages/r/r.contribution';
// json 没有 basic-language 分词表，它的高亮在 language/json 里（带一个 worker，这里只要分词，不起 worker）
import 'monaco-editor/esm/vs/language/json/monaco.contribution';

// 编辑器核心 worker + json 那个（json 高亮走它）；ts/css/html 的语言 worker 不带 —— 阅读器用不上补全与诊断
globalThis.MonacoEnvironment = { getWorker: (_id, label) => (label === 'json' ? new jsonWorker() : new editorWorker()) };
loader.config({ monaco });

export { monaco };
