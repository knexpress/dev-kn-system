    # FRONTEND PROMPT: Optimize Operations Invoice Requests Page Performance

    ## PRIORITY: HIGH - Performance Critical
    ## TARGET: Sub-100ms response time, prevent 4-minute load times

    ---

    ## PROBLEM STATEMENT

    The Operations invoice requests page is taking **4+ minutes** to load, causing poor user experience. The backend has been optimized, but the frontend needs optimization to match.

    ---

    ## BACKEND OPTIMIZATIONS COMPLETED

    The backend has been optimized with:
    1. ✅ Removed employee population (major performance bottleneck)
    2. ✅ Removed CANCELLED filter for Operations queries (only applies to Finance)
    3. ✅ Added compound indexes for Operations queries
    4. ✅ Optimized count query to prevent timeouts
    5. ✅ Field projection for reduced payload size

    ---

    ## FRONTEND OPTIMIZATION REQUIREMENTS

    ### 1. USE FIELD PROJECTION

    **Current Issue**: Frontend may be requesting all fields, causing large payloads.

    **Solution**: Request only required fields using the `fields` query parameter.

    **Example Request**:
    ```javascript
    // ❌ BAD - Requests all fields (slow, large payload)
    GET /api/invoice-requests?page=1&limit=50

    // ✅ GOOD - Requests only required fields (fast, small payload)
    GET /api/invoice-requests?page=1&limit=50&fields=_id,status,delivery_status,createdAt,updatedAt,tracking_code,invoice_number,customer_name,customer_phone,receiver_name,receiver_company,receiver_phone,receiver_address,origin_place,destination_place,service_code,weight,weight_kg,number_of_boxes,verification.actual_weight,verification.number_of_boxes,verification.chargeable_weight,verification.total_kg,verification.shipment_classification,verification.insured,verification.declared_value,verification.volumetric_weight,has_delivery,is_leviable
    ```

    **Recommended Fields for Operations List View**:
    ```
    _id,status,delivery_status,createdAt,updatedAt,tracking_code,invoice_number,customer_name,customer_phone,receiver_name,receiver_company,receiver_phone,receiver_address,origin_place,destination_place,service_code,weight,weight_kg,number_of_boxes,verification.actual_weight,verification.number_of_boxes,verification.chargeable_weight,verification.total_kg,verification.shipment_classification,verification.insured,verification.declared_value,verification.volumetric_weight,has_delivery,is_leviable
    ```

    ### 2. IMPLEMENT PAGINATION

    **Current Issue**: Frontend may be loading all records at once.

    **Solution**: Always use pagination with reasonable limits.

    **Example**:
    ```javascript
    // ✅ GOOD - Use pagination
    const fetchInvoiceRequests = async (page = 1, limit = 50) => {
    const response = await fetch(
        `/api/invoice-requests?page=${page}&limit=${limit}&fields=${FIELDS_FOR_LIST_VIEW}`
    );
    return response.json();
    };
    ```

    **Pagination Metadata Available**:
    ```json
    {
    "pagination": {
        "page": 1,
        "limit": 50,
        "total": 150,
        "pages": 3,
        "hasNextPage": true,
        "hasPreviousPage": false,
        "nextPage": 2,
        "previousPage": null,
        "startRecord": 1,
        "endRecord": 50,
        "summary": "Showing 1-50 of 150 invoice requests",
        "displayText": "Invoice Requests (1-50 of 150)"
    }
    }
    ```

    ### 3. AVOID UNNECESSARY REQUESTS

    **Current Issue**: Frontend may be making multiple requests or refetching unnecessarily.

    **Solutions**:
    - ✅ Use React Query or SWR for caching and request deduplication
    - ✅ Implement request debouncing for search/filter inputs
    - ✅ Cache responses and only refetch when needed
    - ✅ Use `Cache-Control` headers (backend sets these)

    **Example with React Query**:
    ```javascript
    import { useQuery } from '@tanstack/react-query';

    const useInvoiceRequests = (page, limit, status, fields) => {
    return useQuery({
        queryKey: ['invoiceRequests', page, limit, status, fields],
        queryFn: () => fetchInvoiceRequests(page, limit, status, fields),
        staleTime: 30000, // Cache for 30 seconds
        cacheTime: 5 * 60 * 1000, // Keep in cache for 5 minutes
    });
    };
    ```

    ### 4. LAZY LOAD EMPLOYEE DATA

    **Current Issue**: Employee data is no longer populated by default (for performance).

    **Solution**: If employee names are needed, fetch them separately or use employee IDs.

    **Example**:
    ```javascript
    // Employee IDs are still returned in the response
    // Fetch employee details separately if needed
    const employeeIds = invoiceRequests
    .map(req => [req.created_by_employee_id, req.assigned_to_employee_id])
    .flat()
    .filter(Boolean);

    // Fetch employees in a separate request (only if needed)
    const employees = await fetchEmployees(employeeIds);
    ```

    ### 5. OPTIMIZE RENDERING

    **Current Issue**: Rendering large lists can be slow.

    **Solutions**:
    - ✅ Use virtual scrolling (react-window, react-virtualized)
    - ✅ Implement lazy loading for list items
    - ✅ Memoize expensive components
    - ✅ Use React.memo for list items

    **Example with Virtual Scrolling**:
    ```javascript
    import { FixedSizeList } from 'react-window';

    const InvoiceRequestList = ({ items }) => {
    const Row = ({ index, style }) => (
        <div style={style}>
        <InvoiceRequestItem item={items[index]} />
        </div>
    );

    return (
        <FixedSizeList
        height={600}
        itemCount={items.length}
        itemSize={100}
        width="100%"
        >
        {Row}
        </FixedSizeList>
    );
    };
    ```

    ### 6. DEBOUNCE SEARCH/FILTER INPUTS

    **Current Issue**: Search/filter inputs trigger requests on every keystroke.

    **Solution**: Debounce search inputs (300-500ms delay).

    **Example**:
    ```javascript
    import { useDebouncedValue } from './hooks';

    const InvoiceRequestSearch = () => {
    const [searchTerm, setSearchTerm] = useState('');
    const debouncedSearch = useDebouncedValue(searchTerm, 300);

    useEffect(() => {
        // Only fetch when debouncedSearch changes
        fetchInvoiceRequests({ search: debouncedSearch });
    }, [debouncedSearch]);
    };
    ```

    ### 7. USE STATUS FILTER FOR OPERATIONS

    **Current Issue**: Operations may be loading all statuses.

    **Solution**: Filter by `IN_PROGRESS` status for Operations department.

    **Example**:
    ```javascript
    // Operations department should filter by status
    const fetchOperationsInvoiceRequests = (page, limit) => {
    return fetchInvoiceRequests(page, limit, 'IN_PROGRESS');
    };
    ```

    ---

    ## API ENDPOINT DETAILS

    ### GET /api/invoice-requests

    **Query Parameters**:
    - `page` (number, default: 1) - Page number
    - `limit` (number, default: 50, max: 500) - Records per page
    - `status` (string, optional) - Filter by status (e.g., 'IN_PROGRESS', 'VERIFIED')
    - `search` (string, optional) - Search term
    - `fields` (string, optional) - Comma-separated list of fields to return

    **Response Format**:
    ```json
    {
    "success": true,
    "data": [...],
    "pagination": {
        "page": 1,
        "limit": 50,
        "total": 150,
        "pages": 3,
        "hasNextPage": true,
        "hasPreviousPage": false,
        "nextPage": 2,
        "previousPage": null,
        "startRecord": 1,
        "endRecord": 50,
        "summary": "Showing 1-50 of 150 invoice requests",
        "displayText": "Invoice Requests (1-50 of 150)"
    }
    }
    ```

    **Performance Notes**:
    - Response time: < 100ms (with optimizations)
    - Payload size: 70-80% reduction with field projection
    - Employee population: Disabled for performance (IDs still returned)

    ---

    ## IMPLEMENTATION CHECKLIST

    - [ ] Update API calls to use `fields` parameter
    - [ ] Implement pagination (don't load all records)
    - [ ] Add request caching (React Query/SWR)
    - [ ] Debounce search/filter inputs (300ms)
    - [ ] Use virtual scrolling for large lists
    - [ ] Filter by `IN_PROGRESS` status for Operations
    - [ ] Remove unnecessary employee data fetching
    - [ ] Test with 1000+ invoice requests
    - [ ] Verify sub-100ms response times
    - [ ] Monitor network tab for request optimization

    ---

    ## EXPECTED PERFORMANCE IMPROVEMENTS

    **Before Optimization**:
    - Load time: 4+ minutes
    - Payload size: ~5-10 MB
    - Requests: Multiple, unoptimized

    **After Optimization**:
    - Load time: < 1 second
    - Payload size: ~500 KB - 1 MB (with field projection)
    - Requests: Single, cached, optimized

    ---

    ## TESTING REQUIREMENTS

    1. Test with 1000+ invoice requests in database
    2. Verify pagination works correctly
    3. Verify field projection reduces payload size
    4. Verify search/filter debouncing works
    5. Verify virtual scrolling handles large lists
    6. Verify caching prevents unnecessary requests
    7. Measure actual load times (should be < 1 second)

    ---

    ## NOTES

    - Backend no longer populates employee data by default (for performance)
    - Employee IDs are still returned if needed for separate fetching
    - Field projection is optional but highly recommended
    - Pagination is required for large datasets
    - Caching is recommended to prevent duplicate requests

    ---

    ## END OF PROMPT



