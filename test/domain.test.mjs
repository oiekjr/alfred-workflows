import assert from "node:assert/strict";
import test from "node:test";
import {
  REPOSITORY_GRAPHQL_QUERY,
  avatarOwnerIDFromURL,
  filterProjects,
  filterRepositories,
  hasProjectReadScope,
  isGitHubProjectURL,
  isGitHubRepositoryURL,
  normalizeProjects,
  normalizeRepositories,
  normalizedAvatarURL,
  parseGitHubCLIVersion,
  parseProjects,
  parseRepositoryPages,
  projectItems,
  repositoryItems,
  routeInput,
  supportedGitHubCLIVersion,
} from "../workflows/github-repositories/src/domain.mjs";
import { testProject, testRepository } from "./helpers.mjs";

test("repository GraphQL query includes every viewer and owner affiliation", () => {
  assert.match(
    REPOSITORY_GRAPHQL_QUERY,
    /^\s+affiliations: \[OWNER, COLLABORATOR, ORGANIZATION_MEMBER\]$/mu,
  );
  assert.match(
    REPOSITORY_GRAPHQL_QUERY,
    /^\s+ownerAffiliations: \[OWNER, COLLABORATOR, ORGANIZATION_MEMBER\]$/mu,
  );
});

test("routeInput classifies exact fixed commands and project queries", () => {
  assert.deepEqual(routeInput(" issues "), { mode: "issues", query: "" });
  assert.deepEqual(routeInput("PR"), { mode: "pull_requests", query: "" });
  assert.deepEqual(routeInput("projects Road Map"), {
    mode: "projects",
    query: "Road Map",
  });
  assert.deepEqual(routeInput("issue example"), {
    mode: "repositories",
    query: "issue example",
  });
});

test("GitHub CLI version parsing enforces the minimum version", () => {
  assert.deepEqual(parseGitHubCLIVersion("gh version 2.60.0 (date)"), {
    major: 2,
    minor: 60,
    patch: 0,
  });
  assert.equal(supportedGitHubCLIVersion({ major: 2, minor: 59, patch: 9 }), false);
  assert.equal(supportedGitHubCLIVersion({ major: 2, minor: 60, patch: 0 }), true);
  assert.equal(parseGitHubCLIVersion("unexpected"), null);
});

test("repository normalization rejects unsafe URLs and sorts stable names", () => {
  const result = normalizeRepositories([
    testRepository({
      id: 2,
      full_name: "Owner/Zeta",
      html_url: "https://github.com/Owner/Zeta",
    }),
    testRepository({
      id: 1,
      full_name: "owner/alpha",
      html_url: "https://github.com/owner/alpha",
      description: "  first\n repository  ",
    }),
    testRepository({ html_url: "https://evil.example/owner/repository" }),
  ]);

  assert.equal(result.validCount, 2);
  assert.deepEqual(result.values.map((value) => value.full_name), [
    "owner/alpha",
    "Owner/Zeta",
  ]);
  assert.equal(result.values[0].description, "first repository");
});

test("repository ordering preserves case ties and duplicate stability", () => {
  const repositories = ["owner/zeta", "owner/alpha", "Owner/Alpha", "owner/alpha"]
    .map((fullName, index) => testRepository({
      id: index + 1,
      full_name: fullName,
      html_url: `https://github.com/${fullName}`,
    }));
  const original = structuredClone(repositories);

  const result = normalizeRepositories(repositories);

  assert.deepEqual(result.values.map((repository) => repository.id), [3, 2, 4, 1]);
  assert.deepEqual(normalizeRepositories(result.values).values.map((repository) => repository.id), [3, 2, 4, 1]);
  assert.deepEqual(repositories, original);
  assert.deepEqual(Object.keys(result.values[0]).sort(), Object.keys(testRepository()).sort());
});

test("project ordering preserves folded owner, Unicode title, number, and stable ties", () => {
  const projects = [
    ["Zulu", "Alpha", 1],
    ["Alpha", "Équipe", 2],
    ["alpha", "équipe", 1],
    ["alpha", "Alpha", 9],
    ["ALPHA", "ÉQUIPE", 1],
  ].map(([login, title, number], index) => testProject({
    id: `PVT_${index}`,
    number,
    title,
    html_url: `https://github.com/orgs/${login}/projects/${number}`,
    owner: { ...testProject().owner, login },
  }));
  const original = structuredClone(projects);

  const result = normalizeProjects(projects);

  assert.deepEqual(result.values.map((project) => project.id), ["PVT_3", "PVT_2", "PVT_4", "PVT_1", "PVT_0"]);
  assert.deepEqual(normalizeProjects(result.values).values.map((project) => project.id), ["PVT_3", "PVT_2", "PVT_4", "PVT_1", "PVT_0"]);
  assert.deepEqual(projects, original);
  assert.deepEqual(Object.keys(result.values[0]).sort(), Object.keys(testProject()).sort());
});

for (const logins of [["alpha", "beta", "gamma"], ["gamma", "alpha", "beta"]]) {
  test(`projects in ${logins.join(",")} order avoid folding titles when owners determine the order`, (context) => {
    const title = "İ".repeat(480);
    const projects = logins.map((login, index) => testProject({
      id: `PVT_${index + 1}`,
      title,
      html_url: `https://github.com/orgs/${login}/projects/1`,
      owner: { ...testProject().owner, id: index + 1, node_id: `O_${index + 1}`, login },
    }));
    const originalLowercase = String.prototype.toLowerCase;
    let titleFolds = 0;
    context.mock.method(String.prototype, "toLowerCase", countedLowercase);

    const result = normalizeProjects(projects);

    assert.deepEqual(result.values.map((project) => project.owner.login), ["alpha", "beta", "gamma"]);
    assert.deepEqual(result.values.map((project) => project.title), [title, title, title]);
    // 所有者名で順序が確定する場合の不要な文字列変換を防ぐ
    assert.equal(titleFolds, 0);

    /**
     * 対象タイトルの小文字化回数を記録する。
     *
     * @this {string}
     * @returns {string} 元の小文字化処理の結果
     */
    function countedLowercase() {
      if (String(this) === title) {
        titleFolds += 1;
      }
      return originalLowercase.call(this);
    }
  });
}

test("repository page parsing joins pages and derives owner IDs", () => {
  const first = testRepository({
    owner: {
      login: "owner",
      avatar_url: "https://avatars.githubusercontent.com/u/10?v=4",
      type: "User",
    },
  });
  const second = testRepository({
    id: 2,
    full_name: "org/second",
    html_url: "https://github.com/org/second",
    owner: {
      login: "org",
      avatar_url: "https://avatars.githubusercontent.com/u/20?v=4",
      type: "Organization",
    },
  });
  const output = [
    JSON.stringify({ login: "Owner", repositories: [first] }),
    JSON.stringify({ login: "owner", repositories: [second] }),
  ].join("\n");

  const response = parseRepositoryPages(output);

  assert.equal(response.login, "owner");
  assert.deepEqual(
    response.repositories.map((repository) => repository.owner.id),
    [10, 20],
  );
});

test("repository page parsing rejects account changes", () => {
  const output = [
    JSON.stringify({ login: "owner", repositories: [] }),
    JSON.stringify({ login: "other", repositories: [] }),
  ].join("\n");

  assert.throws(
    () => parseRepositoryPages(output),
    /account changed/u,
  );
});

test("owner derivation retains explicit IDs and validates each distinct URL", () => {
  const projects = [
    testProject({ owner: { ...testProject().owner, id: undefined } }),
    testProject({ owner: { ...testProject().owner, id: 21 } }),
    testProject({ owner: { ...testProject().owner, id: undefined, avatar_url: "https://example.com/u/20" } }),
    testProject({ owner: { ...testProject().owner, id: undefined, avatar_url: "https://avatars.githubusercontent.com/u/21?v=4" } }),
  ];

  const parsedProjects = parseProjects(projects.map((project) => JSON.stringify(project)).join("\n"));
  const parsedRepositories = parseRepositoryPages(JSON.stringify({ login: "owner", repositories: projects }));

  assert.deepEqual(parsedProjects.map((project) => project.owner.id), [20, 21, undefined, 21]);
  assert.deepEqual(parsedRepositories.repositories.map((repository) => repository.owner.id), [20, 21, undefined, 21]);
});

test("owner derivation does not carry URL results into subsequent responses", () => {
  const output = JSON.stringify({ ...testProject(), owner: { ...testProject().owner, id: undefined } });
  const first = parseProjects(output);
  first[0].owner.id = 999;

  const second = parseProjects(output);

  assert.equal(second[0].owner.id, 20);
});

test("JSON line parsing retains whitespace and CRLF handling", () => {
  const project = testProject();
  const projectOutput = ` \r\n${JSON.stringify(project)}\r\n${JSON.stringify(project)}\r\n `;
  const page = JSON.stringify({ login: "Owner", repositories: [testRepository()] });

  assert.deepEqual(parseProjects(projectOutput), [project, project]);
  assert.deepEqual(parseRepositoryPages(` \r\n${page}\r\n `), {
    login: "owner",
    repositories: [testRepository()],
  });
});

test("JSON line parsing preserves empty response behavior", () => {
  assert.deepEqual(parseProjects(" \r\n\t"), []);
  assert.throws(() => parseRepositoryPages(" \r\n\t"), /no pages/u);
});

test("JSON line parsing rejects blank lines between valid entries", () => {
  const project = JSON.stringify(testProject());
  const page = JSON.stringify({ login: "owner", repositories: [] });

  assert.throws(() => parseProjects(`${project}\n\n${project}`), SyntaxError);
  assert.throws(() => parseRepositoryPages(`${page}\n\n${page}`), SyntaxError);
});

test("JSON line parsing rejects malformed later entries without returning partial results", () => {
  const project = JSON.stringify(testProject());
  const page = JSON.stringify({ login: "owner", repositories: [] });

  assert.throws(() => parseProjects(`${project}\ninvalid`), SyntaxError);
  assert.throws(() => parseRepositoryPages(`${page}\ninvalid`), SyntaxError);
});

test("repository filtering and items remain local and validated", () => {
  const repositories = [
    testRepository({
      private: true,
      archived: true,
      fork: true,
      description: "Useful repository",
    }),
  ];

  assert.equal(filterRepositories(repositories, "POSI").length, 1);
  const items = repositoryItems(repositories, new Map([[10, "/cache/10.png"]]));
  assert.equal(items[0].subtitle, "Private · Archived · Fork — Useful repository");
  assert.deepEqual(items[0].icon, { path: "/cache/10.png" });
});

test("project parsing derives owner IDs only from approved avatar URLs", () => {
  const output = JSON.stringify({
    ...testProject(),
    owner: { ...testProject().owner, id: undefined },
  });
  const projects = parseProjects(output);

  assert.equal(projects[0].owner.id, 20);
});

test("project normalization excludes closed and duplicate projects", () => {
  const first = testProject({ title: "  Delivery\nRoadmap " });
  const duplicate = testProject({ title: "Duplicate" });
  const closed = testProject({
    id: "PVT_2",
    number: 2,
    html_url: "https://github.com/orgs/example-org/projects/2",
    closed: true,
  });
  const result = normalizeProjects([closed, duplicate, first]);

  assert.equal(result.validCount, 2);
  assert.equal(result.openCount, 1);
  assert.equal(result.values[0].title, "Duplicate");
  assert.equal(filterProjects(result.values, "EXAMPLE").length, 1);
});

test("project items use owner and title as local match text", () => {
  const items = projectItems([testProject()], new Map());

  assert.equal(items[0].title, "example-org / Roadmap");
  assert.equal(items[0].match, "example-org Roadmap");
  assert.equal(items[0].arg, "https://github.com/orgs/example-org/projects/1");
});

test("GitHub destination URLs require exact trusted forms", () => {
  assert.equal(
    isGitHubRepositoryURL(
      "https://github.com/owner/repository",
      "owner/repository",
    ),
    true,
  );
  assert.equal(
    isGitHubRepositoryURL(
      "https://github.com/owner/repository?tab=readme",
      "owner/repository",
    ),
    false,
  );
  assert.equal(
    isGitHubProjectURL(
      "https://github.com/orgs/example-org/projects/1",
      testProject().owner,
      1,
    ),
    true,
  );
});

test("avatar URLs bind an approved host path to the owner ID", () => {
  const source = "https://avatars.githubusercontent.com/u/20?v=4";

  assert.equal(avatarOwnerIDFromURL(source), 20);
  assert.equal(normalizedAvatarURL(source, 20), "https://avatars.githubusercontent.com/u/20?s=128");
  assert.equal(normalizedAvatarURL(source, 21), null);
  assert.equal(avatarOwnerIDFromURL("https://example.com/u/20"), null);
});

for (const source of [
  "http://avatars.githubusercontent.com/u/20",
  "https://example.com/u/20",
  "https://avatars.githubusercontent.com:444/u/20",
  "https://user:password@avatars.githubusercontent.com/u/20",
  "https://avatars.githubusercontent.com/u/20#fragment",
  "https://avatars.githubusercontent.com/u/020",
  "https://avatars.githubusercontent.com/u/0",
  "https://avatars.githubusercontent.com/u/9007199254740992",
  "https://avatars.githubusercontent.com/u/20/extra",
  "not-a-url",
]) {
  test(`avatar normalization rejects unsafe URL ${source}`, () => {
    assert.equal(avatarOwnerIDFromURL(source), null);
    assert.equal(normalizedAvatarURL(source, 20), null);
  });
}

test("project scopes accept read or write but reject similar names", () => {
  assert.equal(hasProjectReadScope("'repo', 'read:project'"), true);
  assert.equal(hasProjectReadScope("repo, project"), true);
  assert.equal(hasProjectReadScope("repo, read:project-other"), false);
});
