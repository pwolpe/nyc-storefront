export interface ClusterBorders {
	n: string;
	s: string;
	w: string;
	e: string;
	summary: string;
}

export interface ClusterEdgeLabel {
	street: string;
	side: 'N' | 'S' | 'E' | 'W';
	coord: [number, number];
}

export interface YearRatePoint {
	year: number;
	total: number;
	vacant: number;
	rate: number;
}

export interface ClusterProps {
	id: string;
	tier: 'hot' | 'steady' | 'thriving';
	name: string;
	borough: string;
	neighborhoods: string[];
	crossed_nta_count: number;
	crossed_ntas: string[];
	top_streets: string[];
	borders?: ClusterBorders;
	edge_labels?: ClusterEdgeLabel[];
	block_dist?: [number, number, number, number];
	total_storefronts: number;
	vacant_storefronts: number;
	vacancy_rate: number;
	history?: YearRatePoint[];
	yoy_change?: number | null;
	nta_q3_rate?: number | null;
	nta_qoq_change?: number | null;
	nta_q3_label?: string | null;
	street_count: number;
	segment_count: number;
	tax_block_count: number;
	compactness: number;
	area_km2: number;
	center: [number, number];
	bbox: [number, number, number, number];
}

export interface ClustersFile {
	syncedAt: string;
	meta: {
		source: string;
		totalStorefronts: number;
		vacantStorefronts: number;
		citywideRate: number;
		dofHistory?: YearRatePoint[];
		segmentCount: number;
		dividingSegmentCount: number;
		taxBlockCount: number;
		clusterCount: number;
		hotCount: number;
		steadyCount: number;
		thrivingCount: number;
		improvingCount?: number;
		worseningCount?: number;
		crossingNtaCount: number;
		avgCompactness: number;
	};
	clusters: GeoJSON.FeatureCollection<GeoJSON.Polygon | GeoJSON.MultiPolygon, ClusterProps>;
}

export interface ComptrollerQuarter {
	quarter: string;
	vacancyRate: number;
	totalStorefronts: number;
	vacantStorefronts: number;
	smallBizStorefronts: number;
	smallBizVacant: number;
	rateChange: number | null;
	openings: number | null;
	closings: number | null;
	netChange: number | null;
	smallBizOpenings: number | null;
	smallBizClosings: number | null;
	smallBizNetChange: number | null;
	boroughs: Record<string, number>;
}

export interface ComptrollerSubcategory {
	name: string;
	vacancyRate: number;
	smallBizVacancyRate: number | null;
	total: number;
	vacant: number;
	share: number;
	smallBizTotal: number;
	smallBizVacant: number;
}

export interface ComptrollerNtaRanking {
	nta2020: string;
	ntaname: string;
	boroname: string;
	cdtaname: string;
	quarter: string;
	vacancy_rate: number;
	total_storefronts: number;
	vacant_storefronts: number;
	smallbiz_vacancy_rate: number;
	smallbiz_storefronts: number;
	smallbiz_vacant_storefronts: number;
	smallbiz_concentration: number;
	prior_vacancy_rate: number;
	vacancy_rate_change: number;
	smallbiz_vacancy_rate_change: number;
	sb_net_change_per_1k: number;
	valid_overall: boolean;
	center: [number, number];
}

export interface ComptrollerSummary {
	syncedAt: string;
	sourceUpdated: string;
	latestQuarter: string;
	headline: ComptrollerQuarter;
	quarters: ComptrollerQuarter[];
	subcategories: ComptrollerSubcategory[];
	rankings: {
		highestVacancyNtas: ComptrollerNtaRanking[];
		lowestVacancyNtas: ComptrollerNtaRanking[];
		biggestWorseningNtas: ComptrollerNtaRanking[];
		biggestImprovingNtas: ComptrollerNtaRanking[];
	};
}

export interface BorderCluster {
	id: string;
	name: string;
	vacancy_rate: number;
	vacant_storefronts: number;
	total_storefronts: number;
	tier: 'hot' | 'steady' | 'thriving';
	center: [number, number];
	sharedStreets: string[];
}

export interface StreetSummary {
	slug: string;
	name: string;
	isHoriz: boolean;
	rate: number;
	vacant: number;
	total: number;
	segmentIds: string[];
}

export interface ContextStreetLine {
	id: string;
	name: string;
	between: string;
	line: [number, number][];
}

export interface SegmentSummary {
	id: string;
	streetSlug: string;
	streetName: string;
	between: string;
	endA: string;
	endB: string;
	isHoriz: boolean;
	rate: number;
	vacant: number;
	total: number;
	prevRate?: number | null;
	prevVacant?: number;
	prevTotal?: number;
	yoyChange?: number | null;
	vacantDelta?: number | null;
	isDividing: boolean;
	line: [number, number][];
}

export interface StorefrontItem {
	address: string;
	num: string;
	bbl?: string;
	vacant: boolean;
	activity: string;
	side: string;
	clusterId?: string;
	lat: number;
	lng: number;
}

export interface BlockNavTarget {
	clusterId: string;
	segId: string;
	streetName: string;
	between: string;
}

export interface BlockNavLinks {
	up: BlockNavTarget | null;
	down: BlockNavTarget | null;
	left: BlockNavTarget | null;
	right: BlockNavTarget | null;
	turnLeft: BlockNavTarget | null;
	turnRight: BlockNavTarget | null;
}

export interface SegmentDetail {
	id: string;
	streetSlug: string;
	streetName: string;
	between: string;
	endA: string;
	endB: string;
	isHoriz: boolean;
	sideLabels: [string, string];
	lengthM: number;
	rate: number;
	vacant: number;
	total: number;
	prevRate?: number | null;
	prevVacant?: number;
	prevTotal?: number;
	yoyChange?: number | null;
	vacantDelta?: number | null;
	isDividing: boolean;
	dividingClusters: Array<{
		id: string;
		name: string;
		vacancy_rate: number;
	}>;
	line: [number, number][];
	center: [number, number];
	prevSegId: string | null;
	prevBetween: string | null;
	nextSegId: string | null;
	nextBetween: string | null;
	nav?: BlockNavLinks | null;
	storefronts: StorefrontItem[];
}

export interface TractRateItem {
	id: string;
	rate: number;
	ebRate: number;
	vacant: number;
	total: number;
}

export interface ClusterShard {
	cluster: ClusterProps;
	gridAngleDeg: number;
	geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon;
	tractRates?: TractRateItem[];
	borderClusters: BorderCluster[];
	streetsList: StreetSummary[];
	segments: SegmentSummary[];
	contextLines: ContextStreetLine[];
	segmentDetails: Record<string, SegmentDetail>;
}

export type BlockLotKind =
	| 'vacant'
	| 'occupied'
	| 'mixed'
	| 'residential'
	| 'civic'
	| 'park'
	| 'commercial'
	| 'other';

export interface BlockLot {
	id: string;
	bbl: string;
	address: string;
	houseNum: string;
	side: 'A' | 'B';
	sideLabel: string;
	t: number; // IRL 0..1 position along segment (endA -> endB)
	x0: number; // laid-out left edge 0..1 (non-overlapping)
	x1: number; // laid-out right edge 0..1 (non-overlapping)
	frontFt: number;
	floors: number;
	unitsRes: number;
	yearBuilt: number | null;
	bldgClass: string;
	landUseLabel: string;
	kind: BlockLotKind;
	isCorner: boolean;
	vacantCount: number;
	occupiedCount: number;
	clusterId: string | null;
	lat: number;
	lng: number;
	storefronts: StorefrontItem[];
}

export interface BlockLotsResponse {
	clusterId: string;
	segmentId: string;
	plutoLoaded: boolean;
	plutoCount: number;
	sideA: BlockLot[];
	sideB: BlockLot[];
}

export interface TenantRecord {
	name: string;
	category: string;
	source: 'DOHMH' | 'DCWP';
	status: 'active' | 'recent' | 'former';
	lastDate: string | null;
}

export interface BlockTenantInfo {
	tenants: TenantRecord[];
	vacantYears: number;
	vacantSinceYear: number | null;
	priorActivity: string | null;
	byYear?: Record<string, { v: number; o: number }>;
}

export interface BlockTenantsResponse {
	byBbl: Record<string, BlockTenantInfo>;
	years?: number[];
}

export interface LandlordPortfolioBuilding {
	bbl: string;
	address: string;
	borough: string;
	vacant: number;
	total: number;
	vacantYears: number;
	href: string | null;
	isCurrent: boolean;
}

export interface LandlordXrayResponse {
	bbl: string;
	plutoOwner: string;
	entityName: string;
	matchedVia: 'HPD Managing Agent' | 'HPD Head Officer' | 'HPD Corporate Owner' | 'NYC Owner Name';
	businessAddress: string | null;
	totalBuildings: number;
	commercialBuildings: number;
	totalStorefronts: number;
	vacantStorefronts: number;
	buildings: LandlordPortfolioBuilding[];
}

export interface StreetViewAuditResult {
	configured: boolean;
	bbl: string;
	visualStatus: 'open' | 'vacant' | 'construction' | 'unclear';
	signageText: string | null;
	signals: string[];
	summary: string;
	discrepancy: {
		flagged: boolean;
		headline: string;
	} | null;
	captureDate: string | null;
}

export interface BuildingDofYear {
	year: number;
	total: number;
	vacant: number;
	occupied: number;
	units: Array<{
		address: string;
		vacant: boolean;
		activity: string;
		construction: boolean;
		leaseExpiry?: string | null;
	}>;
}

export interface BuildingDroppedSignal {
	priorYear: number;
	priorCount: number;
	latestYear: number;
	latestCount: number;
	droppedCount: number;
	priorAddresses: string[];
}

export interface BuildingOathItem {
	date: string;
	agency: string;
	respondent: string;
	address: string;
	description: string;
	status: string;
	amount: number | null;
}

export interface Building311Item {
	date: string;
	address: string;
	type: string;
	descriptor: string;
	status: string;
}

export interface BuildingPermitItem {
	date: string;
	jobType: string;
	workType: string;
	status: string;
	description: string;
	owner: string;
}

export interface BuildingTenantItem {
	name: string;
	category: string;
	source: 'DOHMH' | 'DCWP' | 'OPEN_RESTAURANTS' | 'OATH';
	status: 'active' | 'recent' | 'former';
	firstDate: string | null;
	lastDate: string | null;
	inspections: number;
}

export interface BuildingDossier {
	bbl: string;
	borough: string;
	block: string;
	lot: string;
	address: string;
	ownerName: string;
	isCondo?: boolean;
	zipcode: string;
	zoning: string;
	bldgClass: string;
	landUseLabel: string;
	yearBuilt: number | null;
	floors: number | null;
	lotFrontFt: number | null;
	lotDepthFt: number | null;
	bldgAreaSqft: number | null;
	retailAreaSqft: number | null;
	resAreaSqft: number | null;
	unitsRes: number;
	unitsTotal: number;
	assessedTotal: number | null;
	assessedLand: number | null;
	councilDistrict: string;
	lat: number | null;
	lng: number | null;
	parcelGeometry: GeoJSON.Polygon | GeoJSON.MultiPolygon | null;
	streetViewAvailable: boolean;
	streetViewDate: string | null;
	tenants: BuildingTenantItem[];
	dofHistory: BuildingDofYear[];
	droppedSignal: BuildingDroppedSignal | null;
	consecutiveVacantYears: number;
	oathCases: BuildingOathItem[];
	complaints311: Building311Item[];
	permits: BuildingPermitItem[];
}
