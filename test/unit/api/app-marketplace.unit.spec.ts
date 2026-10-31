jest.mock('../../../src/db/models/app-marketplace.model', () => ({
	AppMarketplaceModel: {
		getAll: jest.fn(),
		getById: jest.fn(),
		create: jest.fn(),
		update: jest.fn(),
		delete: jest.fn(),
	},
}));

import { AppMarketplaceModel } from '../../../src/db/models/app-marketplace.model';
import { router } from '../../../src/api/v1';

const template = {
	id: 'custom-image',
	name: 'Custom Image',
	category: 'Custom',
	description: 'A custom deployment',
	color: '#123456',
	letter: 'CI',
	appName: 'custom-app',
	services: [{ serviceName: 'custom-service', image: 'example/custom:1' }],
};

function routeHandler(path: string, method: 'get' | 'post' | 'put' | 'delete') {
	const route = (router as any).stack.find(
		(layer: any) => layer.route?.path === path && layer.route.methods[method],
	)?.route;
	return route.stack[route.stack.length - 1].handle;
}

function response() {
	return {
		status: jest.fn().mockReturnThis(),
		json: jest.fn().mockReturnThis(),
		send: jest.fn().mockReturnThis(),
	};
}

describe('marketplace catalog API', () => {
	beforeEach(() => jest.clearAllMocks());

	it('preserves the catalog list response and derives categories from persisted entries', () => {
		(AppMarketplaceModel.getAll as jest.Mock).mockReturnValue([template]);
		const res = response();

		routeHandler('/v1/app-templates', 'get')({}, res, jest.fn());

		expect(res.status).toHaveBeenCalledWith(200);
		expect(res.json).toHaveBeenCalledWith({ templates: [template], categories: ['All', 'Custom'] });
	});

	it('rejects invalid entries before persisting them', () => {
		const res = response();

		routeHandler('/v1/app-templates', 'post')({ body: { ...template, services: [] } }, res, jest.fn());

		expect(res.status).toHaveBeenCalledWith(400);
		expect(AppMarketplaceModel.create).not.toHaveBeenCalled();
	});

	it('creates a validated entry and rejects duplicate identifiers', () => {
		const create = routeHandler('/v1/app-templates', 'post');
		const res = response();
		(AppMarketplaceModel.getById as jest.Mock).mockReturnValue(null);
		(AppMarketplaceModel.create as jest.Mock).mockReturnValue(template);

		create({ body: template }, res, jest.fn());
		expect(res.status).toHaveBeenCalledWith(201);
		expect(res.json).toHaveBeenCalledWith(template);

		const duplicateResponse = response();
		(AppMarketplaceModel.getById as jest.Mock).mockReturnValue(template);
		create({ body: template }, duplicateResponse, jest.fn());
		expect(duplicateResponse.status).toHaveBeenCalledWith(409);
	});

	it('updates and deletes only the catalog entry selected by id', () => {
		const put = routeHandler('/v1/app-templates/:id', 'put');
		const del = routeHandler('/v1/app-templates/:id', 'delete');
		const updateResponse = response();
		(AppMarketplaceModel.update as jest.Mock).mockReturnValue(template);

		put({ params: { id: template.id }, body: template }, updateResponse, jest.fn());
		expect(updateResponse.status).toHaveBeenCalledWith(200);
		expect(AppMarketplaceModel.update).toHaveBeenCalledWith(template.id, template);

		const deleteResponse = response();
		(AppMarketplaceModel.delete as jest.Mock).mockReturnValue(true);
		del({ params: { id: template.id } }, deleteResponse, jest.fn());
		expect(AppMarketplaceModel.delete).toHaveBeenCalledWith(template.id);
		expect(deleteResponse.status).toHaveBeenCalledWith(204);
	});
});
