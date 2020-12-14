import { Application } from "probot";
import { PushContext } from "../../types";
import { basename } from "path";
import {
  ReposListCommitsResponseData,
  ReposListPullRequestsAssociatedWithCommitResponseData,
} from "@octokit/types";
import { resolve } from "path";
import { readFileSync } from "fs";
import nunjucks from "nunjucks";

export class ReleaseDrafter {
  public context: PushContext;
  public branchName: string;

  constructor(context: PushContext) {
    this.context = context;
    this.branchName = basename(context.payload.ref);
  }

  async draftRelease(): Promise<any> {
    const { context, branchName } = this;
    const repo = context.payload.repository.name;
    const { created, deleted } = context.payload;
    console.log(`Drafting release for branch '${branchName}' of '${repo}'.`);

    // Don't run on branch created/delete pushes
    if (created || deleted) {
      const action = created ? "created" : "deleted";
      console.warn(`Release drafts not generated on action: ${action}`);
      return;
    }

    // Only run draft-releaser on release branches
    if (!this.isVersionedBranch()) {
      console.warn(
        "Release drafts are only supported for 'branch-0.xx' branches."
      );
      return;
    }

    const branchVersionNumber: number = parseInt(branchName.split(".")[1]);
    const mergeBaseCommitSHA = await this.getMergeBaseSHA(branchVersionNumber);
    const commits = await this.getRangeCommits(mergeBaseCommitSHA);
    const commitPRs = await this.getUniqueCommitPRs(commits);
    const releaseName = `v0.${branchVersionNumber}.0`;
    const releaseDraftBody = this.getReleaseDraftBody(commitPRs, releaseName);
    const releaseId = await this.getExistingDraftReleaseId(releaseName);
    await this.createOrUpdateDraftRelease(
      releaseId,
      releaseName,
      releaseDraftBody
    );

    console.log(
      `Release notes for branch '${branchName}' of '${repo}' published.`
    );
  }

  /**
   * Returns the SHA of the merge_base_commit (the common commit between the
   * current and previous branch). Returns an empty string if no previous branch
   * exists.
   * @param context
   * @param branchVersionNumber
   */
  async getMergeBaseSHA(branchVersionNumber: number): Promise<string> {
    const { context, branchName } = this;
    const owner = context.payload.repository.owner.login;
    const repo = context.payload.repository.name;
    const previousBranchNumber = branchVersionNumber - 1;
    const previousBranchName = `branch-0.${previousBranchNumber}`;

    try {
      const { data: comparison } = await context.octokit.repos.compareCommits({
        owner,
        repo,
        base: previousBranchName,
        head: branchName,
      });

      return comparison.merge_base_commit.sha;
    } catch (error) {
      console.warn(
        `Branch '${previousBranchName}' not found in '${owner}/${repo}'`
      );

      return "";
    }
  }

  /**
   * Returns true if the branch name matches the "branch-0.xx" pattern
   */
  isVersionedBranch(): boolean {
    const re = /^branch-0.{1,3}\d/;
    return Boolean(this.branchName.match(re));
  }

  /**
   * Returns an array of commits that begins at the merge commit and
   * ends at either previous branch's HEAD commit or the merge/squash commit
   * branch's first commit.
   * @param context
   * @param mergeBaseCommitSHA
   */
  async getRangeCommits(
    mergeBaseCommitSHA: string
  ): Promise<ReposListCommitsResponseData> {
    const context = this.context;
    const owner = context.payload.repository.owner.login;
    const repo = context.payload.repository.name;
    const pushCommitSHA = context.payload.after;
    let page = 1;
    let allCommits: ReposListCommitsResponseData = [];

    do {
      var { data: pageCommits } = await context.octokit.repos.listCommits({
        owner,
        repo,
        sha: pushCommitSHA,
        per_page: 100,
        page,
      });
      for (let i = 0; i < pageCommits.length; i++) {
        const commit = pageCommits[i];
        if (commit.sha === mergeBaseCommitSHA) {
          return allCommits;
        }
        allCommits.push(commit);
      }
      page++;
    } while (pageCommits.length);
    return allCommits;
  }

  /**
   * Returns an array of PRs associated with the given array of commits
   * @param context
   * @param commits
   */
  async getUniqueCommitPRs(
    commits: ReposListCommitsResponseData
  ): Promise<ReposListPullRequestsAssociatedWithCommitResponseData> {
    const context = this.context;
    const owner = context.payload.repository.owner.login;
    const repo = context.payload.repository.name;
    const uniquePRs: ReposListPullRequestsAssociatedWithCommitResponseData = [];

    // Get PR associations simultaneously to reduce overall execution time
    const commitPRs = await Promise.all(
      commits.map((commit) =>
        context.octokit.repos.listPullRequestsAssociatedWithCommit({
          owner,
          repo,
          commit_sha: commit.sha,
        })
      )
    );

    for (let i = 0; i < commitPRs.length; i++) {
      const { data: prs } = commitPRs[i];

      if (!prs.length) {
        console.log(`No PRs associated with commit ${commits[i].sha}.`);
        continue;
      }

      const pr = prs[0]; // there "should" be only one PR associated with each commit

      if (uniquePRs.find((el) => el.number === pr.number)) {
        console.log(`PR #${pr.number} already accounted for.`);
        continue;
      }

      // @ts-ignore - Octokit type issue
      uniquePRs.push(pr);
    }
    return uniquePRs;
  }

  /**
   * Returns the body string for the release draft
   * @param prs
   * @param releaseTitle
   */
  getReleaseDraftBody(
    prs: ReposListPullRequestsAssociatedWithCommitResponseData,
    releaseTitle: string
  ): string {
    const categories = {
      bug: { title: "Bug Fixes", prs: [] },
      doc: { title: "Documentation", prs: [] },
      "feature request": { title: "New Features", prs: [] },
      improvement: { title: "Improvements", prs: [] },
    };

    const breakingPRs: ReposListPullRequestsAssociatedWithCommitResponseData = [];

    const labelInCategories = (el) => Object.keys(categories).includes(el.name);

    for (let i = 0; i < prs.length; i++) {
      const pr = prs[i];
      const categoryLabel = pr.labels.find(labelInCategories);
      if (!categoryLabel) {
        console.warn(
          `No category label found for PR ${pr.number} - ${pr.title}. Skipping changelog entry...`
        );
        continue;
      }
      const category = categoryLabel.name;
      categories[category].prs.push(pr);

      if (pr.labels.find((el) => el.name === "breaking")) {
        breakingPRs.push(pr);
      }
    }

    const templatePath = resolve(__dirname, "draft_template.njk");
    const templateStr = readFileSync(templatePath, "utf-8");

    const nj = new nunjucks.Environment(null, {
      trimBlocks: true,
      lstripBlocks: true,
    });

    // Remove square brackets from title
    nj.addFilter("sanitizeTitle", (title) =>
      title.replace(/\[[\s\S]*?\]/g, "").trim()
    );

    return nj
      .renderString(templateStr, {
        categories,
        releaseTitle,
        breaking: breakingPRs,
      })
      .trim();
  }

  /**
   * Returns the ID of an existing draft release whose name is releaseName.
   * otherwise returns an empty string.
   * @param context
   * @param releaseName
   */
  async getExistingDraftReleaseId(releaseName: string): Promise<number> {
    const context = this.context;
    const { data: releases } = await context.octokit.repos.listReleases({
      owner: context.payload.repository.owner.login,
      repo: context.payload.repository.name,
      per_page: 20,
    });
    const existingDraftRelease = releases.find(
      (release) => release.name === releaseName && release.draft === true
    );

    if (existingDraftRelease) {
      return existingDraftRelease.id;
    }
    return -1;
  }

  async createOrUpdateDraftRelease(
    releaseId: number,
    releaseName: string,
    releaseBody: string
  ) {
    const context = this.context;
    const owner = context.payload.repository.owner.login;
    const repo = context.payload.repository.name;

    if (releaseId !== -1) {
      await context.octokit.repos.updateRelease({
        owner,
        repo,
        release_id: releaseId,
        body: releaseBody,
      });
      return;
    }

    await context.octokit.repos.createRelease({
      owner,
      repo,
      tag_name: releaseName,
      name: releaseName,
      draft: true,
      body: releaseBody,
    });
  }
}
