export interface MarketplaceImage {
	id: string;
	name: string;
	category: string;
	description: string;
	color: string;
	letter: string;
	image: string;
	ports?: string[];
	volumes?: string[];
	environment?: Record<string, string>;
	restart?: string;
	command?: string;
	entrypoint?: string;
	user?: string;
	networkMode?: string;
	enableSocketDestination?: boolean;
}
