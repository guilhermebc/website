const { Component } = require('@serverless/core')
const {
  log,
  getClients,
  getConfig,
  ensureBucket,
  configureBucketForHosting,
  uploadDir,
  clearBucket,
  deleteBucket,
  getDomainHostedZoneId,
  ensureCertificate,
  updateCloudFrontDistribution,
  createCloudFrontDistribution,
  invalidateCloudfrontDistribution,
  configureDnsForCloudFrontDistribution,
  removeDomainFromCloudFrontDistribution,
  removeCloudFrontDomainDnsRecords,
  deleteCloudFrontDistribution
} = require('./utils')

class Website extends Component {
  async deploy(inputs) {
    let config = getConfig(inputs, this.state)

    const clients = getClients(this.credentials.aws, config.region)

    // Throw error on name change
    if (this.state.bucketName && this.state.bucketName !== config.bucketName) {
      throw new Error(
        `Changing the bucket name from ${this.state.bucketName} to ${inputs.config} will remove your infrastructure.  Please remove it manually, change the bucket name, then re-deploy.`
      )
    }

    // Throw error on domain change
    if (this.state.domain && this.state.domain !== config.domain) {
      throw new Error(
        `Changing the domain from ${this.state.domain} to ${config.domain} will remove your infrastructure.  Please remove it manually, change the domain, then re-deploy.`
      )
    }

    // Throw error on region change
    if (this.state.region && this.state.region !== config.region) {
      throw new Error(
        `Changing the region from ${this.state.region} to ${config.region} will remove your infrastructure.  Please remove it manually, change the region, then re-deploy.`
      )
    }

    if (config.domain) {
      log(`Setting up domain ${config.domain}`)

      if (!config.domainHostedZoneId) {
        this.state.domainHostedZoneId = await getDomainHostedZoneId(clients, config)
        await this.save()
        config.domainHostedZoneId = this.state.domainHostedZoneId
      }

      if (!config.certificateArn) {
        this.state.certificateArn = await ensureCertificate(clients, config, this)
        await this.save()
        config.certificateArn = this.state.certificateArn
      }
    }

    log(`Deploying Bucket ${config.bucketName} to region ${config.region}`)
    await ensureBucket(clients, config.bucketName, this)

    this.state.bucketName = config.bucketName
    this.state.region = config.region
    this.state.bucketUrl = config.bucketUrl
    await this.save()

    log(`Deploying Website`)
    if (!this.state.configured) {
      log(`Configuring bucket for hosting`)
      log(`Uploading Website files`)
      await Promise.all([
        configureBucketForHosting(clients, config.bucketName),
        uploadDir(clients, config.bucketName, config.src, this)
      ])

      this.state.configured = true
      await this.save()
    } else {
      log(`Uploading Website files`)
      await uploadDir(clients, config.bucketName, config.src, this)
    }

    let newDistribution
    if (config.distributionId) {
      log(`Updating CloudFront distribution of ID ${config.distributionId}.`)
      newDistribution = await updateCloudFrontDistribution(clients, config)

      log(`Invalidating CloudFront cache for distribution ${config.distributionId}.`)
      await invalidateCloudfrontDistribution(clients, config)
    } else {
      log(`Creating CloudFront distribution in the ${config.region} region.`)
      newDistribution = await createCloudFrontDistribution(clients, config)
    }

    if (newDistribution) {
      this.state = { ...this.state, ...newDistribution }
      await this.save()
      config = { ...config, ...newDistribution }
    }

    if (config.domain && !this.state.domain) {
      log(`Configuring DNS records for domain "${config.domain}"`)
      await configureDnsForCloudFrontDistribution(clients, config)
      this.state.domain = config.domain
      this.state.nakedDomain = config.nakedDomain
      await this.save()
    }

    log(
      `Website with bucketName ${config.bucketName} was successfully deployed to region ${config.region}`
    )

    const outputs = {
      bucket: this.state.bucketName,
      url: `https://${this.state.distributionUrl}`
    }

    if (this.state.domain) {
      outputs.domain = `https://${this.state.domain}`
    }

    return outputs
  }

  async remove() {
    if (Object.keys(this.state).length === 0) {
      log(`State is empty. Nothing to remove`)
      return {}
    }
    const config = this.state

    const clients = getClients(this.credentials.aws, this.state.region)

    log(`Clearing bucket ${config.bucketName}`)
    await clearBucket(clients, config.bucketName)

    log(`Deleting bucket ${config.bucketName} from the ${config.region} region`)
    await deleteBucket(clients, config.bucketName)

    if (this.state.domain) {
      log(
        `Removing domain "${this.state.domain}" from CloudFront distribution with ID ${this.state.distributionId}`
      )
      await removeDomainFromCloudFrontDistribution(clients, this.state)

      log(`Deleting DNS records for domain "${this.state.domain}"`)
      await removeCloudFrontDomainDnsRecords(clients, this.state)
    }

    if (this.state.distributionId) {
      log(`Deleting Cloudfront distribution ${this.state.distributionId}`)
      await deleteCloudFrontDistribution(clients, this.state.distributionId)
    }

    log(`Website ${config.bucketName} was successfully removed from region ${config.region}`)

    this.state = {}
    await this.save()

    log(`Website Removed`)
    return {}
  }
}

module.exports = Website