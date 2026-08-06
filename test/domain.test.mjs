import assert from "node:assert/strict";
import test from "node:test";
import {
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

test("project scopes accept read or write but reject similar names", () => {
  assert.equal(hasProjectReadScope("'repo', 'read:project'"), true);
  assert.equal(hasProjectReadScope("repo, project"), true);
  assert.equal(hasProjectReadScope("repo, read:project-other"), false);
});
