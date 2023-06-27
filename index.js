const { getConfig } = require('./lib/config')
const { isTriggerableReference } = require('./lib/triggerable-reference')
const {
  findReleases,
  generateReleaseInfo,
  createRelease,
  updateRelease,
} = require('./lib/releases')
const { findCommitsWithAssociatedPullRequests } = require('./lib/commits')
const { sortPullRequests } = require('./lib/sort-pull-requests')
const { log } = require('./lib/log')
const core = require('@actions/core')
const { runnerIsActions } = require('./lib/utils')
const ignore = require('ignore')

module.exports = (app, { getRouter }) => {
  if (!runnerIsActions() && typeof getRouter === 'function') {
    getRouter().get('/healthz', (request, response) => {
      response.status(200).json({ status: 'pass' })
    })
  }

  app.on(
    [
      'pull_request.opened',
      'pull_request.reopened',
      'pull_request.synchronize',
      'pull_request.edited',
      'pull_request_target.opened',
      'pull_request_target.reopened',
      'pull_request_target.synchronize',
      'pull_request_target.edited',
    ],
    async (context) => {
      const { disableAutolabeler } = getInput()

      const config = await getConfig({
        context,
        configName: core.getInput('config-name'),
      })

      if (config === null || disableAutolabeler) return

      let issue = {
        ...context.issue({ pull_number: context.payload.pull_request.number }),
      }
      const changedFiles = await context.octokit.paginate(
        context.octokit.pulls.listFiles.endpoint.merge(issue),
        (response) => response.data.map((file) => file.filename)
      )
      const labels = new Set()

      for (const autolabel of config['autolabeler']) {
        let found = false
        // check modified files
        if (!found && autolabel.files.length > 0) {
          const matcher = ignore().add(autolabel.files)
          if (changedFiles.some((file) => matcher.ignores(file))) {
            labels.add(autolabel.label)
            found = true
            log({
              context,
              message: `Found label for files: '${autolabel.label}'`,
            })
          }
        }
        // check branch names
        if (!found && autolabel.branch.length > 0) {
          for (const matcher of autolabel.branch) {
            if (matcher.test(context.payload.pull_request.head.ref)) {
              labels.add(autolabel.label)
              found = true
              log({
                context,
                message: `Found label for branch: '${autolabel.label}'`,
              })
              break
            }
          }
        }
        // check pr title
        if (!found && autolabel.title.length > 0) {
          for (const matcher of autolabel.title) {
            if (matcher.test(context.payload.pull_request.title)) {
              labels.add(autolabel.label)
              found = true
              log({
                context,
                message: `Found label for title: '${autolabel.label}'`,
              })
              break
            }
          }
        }
        // check pr body
        if (
          !found &&
          context.payload.pull_request.body != null &&
          autolabel.body.length > 0
        ) {
          for (const matcher of autolabel.body) {
            if (matcher.test(context.payload.pull_request.body)) {
              labels.add(autolabel.label)
              found = true
              log({
                context,
                message: `Found label for body: '${autolabel.label}'`,
              })
              break
            }
          }
        }
      }

      const labelsToAdd = [...labels]
      if (labelsToAdd.length > 0) {
        let labelIssue = {
          ...context.issue({
            issue_number: context.payload.pull_request.number,
            labels: labelsToAdd,
          }),
        }
        await context.octokit.issues.addLabels(labelIssue)
        if (runnerIsActions()) {
          core.setOutput('number', context.payload.pull_request.number)
          core.setOutput('labels', labelsToAdd.join(','))
        }
        return
      }
    }
  )

  const drafter = async (context) => {
    const {
      shouldDraft,
      configName,
      version,
      tag,
      name,
      disableReleaser,
      commitish,
    } = getInput()

    const config = await getConfig({
      context,
      configName,
    })

    const { isPreRelease } = getInput({ config })

    if (config === null || disableReleaser) return

    // GitHub Actions merge payloads slightly differ, in that their ref points
    // to the PR branch instead of refs/heads/master
    const ref = process.env['GITHUB_REF'] || context.payload.ref

    if (!isTriggerableReference({ ref, context, config })) {
      return
    }

    const targetCommitish = commitish || config['commitish'] || ref
    const {
      'filter-by-commitish': filterByCommitish,
      'include-pre-releases': includePreReleases,
      'tag-prefix': tagPrefix,
    } = config

    // override header and footer when passed as input
    const header = core.getInput('header')
    const footer = core.getInput('footer')
    if (header) {
      config['header'] = header
    }
    if (footer) {
      config['footer'] = footer
    }

    const { draftRelease, lastRelease } = await findReleases({
      context,
      targetCommitish,
      filterByCommitish,
      includePreReleases,
      tagPrefix,
    })

    const { commits, pullRequests: mergedPullRequests } =
      await findCommitsWithAssociatedPullRequests({
        context,
        targetCommitish,
        lastRelease,
        config,
      })

    const sortedMergedPullRequests = sortPullRequests(
      mergedPullRequests,
      config['sort-by'],
      config['sort-direction']
    )

    const releaseInfo = generateReleaseInfo({
      context,
      commits,
      config,
      lastRelease,
      mergedPullRequests: sortedMergedPullRequests,
      version,
      tag,
      name,
      isPreRelease,
      shouldDraft,
      targetCommitish,
    })

    let createOrUpdateReleaseResponse
    if (!draftRelease) {
      log({ context, message: 'Creating new release' })
      createOrUpdateReleaseResponse = await createRelease({
        context,
        releaseInfo,
        config,
      })
    } else {
      log({ context, message: 'Updating existing release' })
      createOrUpdateReleaseResponse = await updateRelease({
        context,
        draftRelease,
        releaseInfo,
        config,
      })
    }

    if (runnerIsActions()) {
      setActionOutput(createOrUpdateReleaseResponse, releaseInfo)
    }
  }

  if (runnerIsActions()) {
    app.onAny(drafter)
  } else {
    app.on('push', drafter)
  }
}

function getInput({ config } = {}) {
  // Returns all the inputs that doesn't need a merge with the config file
  if (!config) {
    return {
      shouldDraft: core.getInput('publish').toLowerCase() !== 'true',
      configName: core.getInput('config-name'),
      version: core.getInput('version') || undefined,
      tag: core.getInput('tag') || undefined,
      name: core.getInput('name') || undefined,
      disableReleaser:
        core.getInput('disable-releaser').toLowerCase() === 'true',
      disableAutolabeler:
        core.getInput('disable-autolabeler').toLowerCase() === 'true',
      commitish: core.getInput('commitish') || undefined,
    }
  }

  // Merges the config file with the input
  // the input takes precedence, because it's more easy to change at runtime
  const preRelease = core.getInput('prerelease').toLowerCase()

  return {
    isPreRelease: preRelease === 'true' || (!preRelease && config.prerelease),
  }
}

function setActionOutput(
  releaseResponse,
  { body, resolvedVersion, majorVersion, minorVersion, patchVersion }
) {
  const {
    data: {
      id: releaseId,
      html_url: htmlUrl,
      upload_url: uploadUrl,
      tag_name: tagName,
      name: name,
    },
  } = releaseResponse
  if (releaseId && Number.isInteger(releaseId))
    core.setOutput('id', releaseId.toString())
  if (htmlUrl) core.setOutput('html_url', htmlUrl)
  if (uploadUrl) core.setOutput('upload_url', uploadUrl)
  if (tagName) core.setOutput('tag_name', tagName)
  if (name) core.setOutput('name', name)
  if (resolvedVersion) core.setOutput('resolved_version', resolvedVersion)
  if (majorVersion) core.setOutput('major_version', majorVersion)
  if (minorVersion) core.setOutput('minor_version', minorVersion)
  if (patchVersion) core.setOutput('patch_version', patchVersion)
  core.setOutput('body', body)
}
