import { autopoiesis } from '../cybernetics-core/src/index.js'

export interface AutopoiesisAssessment {
  hasBoundary: boolean
  boundarySelfProduced: boolean
  internalProduction: boolean
  circularProduction: boolean
  organizationallyClosed: boolean
  organizationMaintained: boolean
  isAutopoietic: boolean
  missingCriteria: string[]
}

export interface AssessmentContext {
  populationExists: boolean
  registryEvolvable: boolean
  identityGuardActive: boolean
}

export class AutopoiesisVerifier {
  private network: InstanceType<typeof autopoiesis.ProductionNetwork>

  constructor() {
    this.network = new autopoiesis.ProductionNetwork()
    const population = this.network.addComponent('ConfigPopulation')
    const homeostat = this.network.addComponent('SessionHomeostat')
    const measurements = this.network.addComponent('Measurements')
    const algedonic = this.network.addComponent('AlgedonicSignals')
    const perturbations = this.network.addComponent('Perturbations')
    const reflector = this.network.addComponent('S4Reflector')
    const identity = this.network.addComponent('IdentityGuard')
    const verdicts = this.network.addComponent('ViabilityVerdicts')

    this.network.addProduction(population, homeostat)
    this.network.addProduction(homeostat, measurements)
    this.network.addProduction(measurements, algedonic)
    this.network.addProduction(algedonic, perturbations)
    this.network.addProduction(perturbations, population)
    this.network.addProduction(reflector, algedonic)
    this.network.addProduction(identity, verdicts)
    this.network.addProduction(verdicts, population)
    this.network.addProduction(homeostat, reflector)
    this.network.addProduction(measurements, identity)
  }

  getComponentCount(): number { return this.network.componentCount() }

  addExternalComponent(name: string): void {
    this.network.addComponent(name)
  }

  verifyClosure(): { closed: boolean; gaps: string[] } {
    return { closed: this.network.isClosed(), gaps: this.network.unproducedComponents() }
  }

  assess(ctx: AssessmentContext): AutopoiesisAssessment {
    const hasBoundary = ctx.populationExists
    const boundarySelfProduced = ctx.registryEvolvable
    const closure = this.verifyClosure()
    const internalProduction = closure.closed
    const circularProduction = closure.closed
    const organizationallyClosed = closure.closed
    const organizationMaintained = ctx.identityGuardActive
    const all = hasBoundary && boundarySelfProduced && internalProduction && circularProduction && organizationallyClosed && organizationMaintained
    const missing: string[] = []
    if (!hasBoundary) missing.push('hasBoundary')
    if (!boundarySelfProduced) missing.push('boundarySelfProduced')
    if (!internalProduction) missing.push('internalProduction')
    if (!circularProduction) missing.push('circularProduction')
    if (!organizationallyClosed) missing.push('organizationallyClosed')
    if (!organizationMaintained) missing.push('organizationMaintained')
    return { hasBoundary, boundarySelfProduced, internalProduction, circularProduction, organizationallyClosed, organizationMaintained, isAutopoietic: all, missingCriteria: missing }
  }
}
