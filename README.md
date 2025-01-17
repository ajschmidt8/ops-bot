# ops-bot

This repo contains a [Probot](https://github.com/probot/probot) application. The application contains the plugins listed below and is deployed using the [probot/serverless-lambda](https://github.com/probot/serverless-lambda) package via the [Serverless framework](https://www.serverless.com/).

## Plugins

The plugins are listed in the [src/plugins](./src/plugins) folder.

- **Label Checker** - Sets a status on PRs that passes if one (and only one) of the following labels from each list have been applied:
  - `bug`, `doc`, `feature request`, or `improvement`
  - `breaking` or `non-breaking`
- **Release Drafter** - Opens up a draft release on GitHub anytime a PR is merged to a versioned branch (i.e. `branch-0.17`, `branch-0.18`, etc.). The draft body includes a categorized changelog consisting of the PRs that have been merged on that branch.
- **Auto Merger** - Automatically merges PRs that include the `/merge` comment and meet the merge criteria outlined in [https://docs.rapids.ai/resources/auto-merger/](https://docs.rapids.ai/resources/auto-merger/).
- **Branch Checker** - Set a status on PRs that checks whether they are targeting either the repo's _default branch_ or _default branch + 1_
- **Copy PRs** - Copies pull request branches from their forked repository to the source repository for testing. If a pull request is from a GitHub author that is not a member of the GitHub organization, it will require an `okay to test` comment be submitted to the PR by a member of the GitHub organization before the forked code is copied to the source repository. Every new commit from external contributor PRs will also require an `okay to test` command. `ok to test` may also be used.
- **Rerun Tests** - Listens for comments on PRs and runs a new Jenkins build if the comment matches a particular regular expression.
- **Recently Updated** - Sets a status on PRs based on whether a PR is `X` commits out-of-date compared to the based branch. `X` defaults to `5`, but is configurable via the `recently_updated_threshold` option in the `.github/ops-bot.yaml` configuration file.

## Deployment

The _Serverless_ framework is used to deploy the Probot application to an AWS Lambda instance. The deployment configuration can be seen in the [serverless.yaml](./serverless.yaml) file. A deployment will happen automatically anytime a change is merged to the `main` branch affecting any of the following files: source code files, `package.json` file, or `serverless.yaml` file. See the [deploy.yaml](/.github/workflows/deploy.yaml) GitHub Action for more details.

## npm Scripts

```sh
# Build
npm run build

# Test
npm run test

# Deploy
npm run deploy
```

## Contributing

Any new functionality should be introduced as a new plugin in the [src/plugins](./src/plugins) directory. New plugins should make use of the shared `featureIsDisabled` function so that repositories can disable the feature if they desire. New plugins should also have an entry added in [config.ts](./src/config.ts)
